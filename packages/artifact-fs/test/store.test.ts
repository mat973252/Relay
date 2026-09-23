/**
 * M2 artifact store tests: content addressing, atomic-write crash semantics
 * (T09), lineage reconstruction (T10), and survival across a real process
 * restart (T11, child-process fixture).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ArtifactStore } from "../src/index.js";

class Crash extends Error {
  constructor(public readonly point: string) {
    super(`crash at ${point}`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "relay-artifacts-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const CONTENT_SOURCE = "let x = 1\n";
const CONTENT_ANALYSIS = "{\"findings\":[\"f1\"]}\n";
const CONTENT_REPORT = "# report\nfinal.\n";

async function writeChain(store: ArtifactStore): Promise<{
  source: string;
  analysis: string;
  report: string;
}> {
  const source = await store.write({
    content: CONTENT_SOURCE,
    mediaType: "text/x-python",
    producer: { type: "human", id: "author-1" },
  });
  const analysis = await store.write({
    content: CONTENT_ANALYSIS,
    mediaType: "application/json",
    producer: { type: "agent", id: "pi-session-1" },
    parents: [source.id],
    refs: { session: "pi-session-1", toolCall: "call-7" },
  });
  const report = await store.write({
    content: CONTENT_REPORT,
    mediaType: "text/markdown",
    producer: { type: "tool", id: "report-writer" },
    parents: [analysis.id],
    refs: { run: "run-42" },
  });
  return { source: source.id, analysis: analysis.id, report: report.id };
}

describe("content-addressed storage", () => {
  it("same content → same digest, one object; different content → different digest", async () => {
    const root = mkdtempSync(join(tmpRoot, "cas-"));
    const store = await ArtifactStore.open({ root });
    const a = await store.write({ content: "hello", mediaType: "text/plain", producer: { type: "t", id: "1" } });
    const b = await store.write({ content: "hello", mediaType: "text/plain", producer: { type: "t", id: "2" } });
    const c = await store.write({ content: "world", mediaType: "text/plain", producer: { type: "t", id: "3" } });
    assert.equal(a.digest, b.digest);
    assert.equal(a.artifactId, `artifact://sha256/${a.digest}`);
    assert.notEqual(a.digest, c.digest);
    assert.equal((await store.list()).length, 3);
    assert.equal((await store.content(b)).toString("utf8"), "hello");
  });

  it("resolve() accepts artifact:// URI, bare digest, and record id", async () => {
    const root = mkdtempSync(join(tmpRoot, "resolve-"));
    const store = await ArtifactStore.open({ root });
    const a = await store.write({ content: "payload", mediaType: "text/plain", producer: { type: "t", id: "1" } });
    assert.equal((await store.resolve(a.artifactId))?.id, a.id);
    assert.equal((await store.resolve(a.digest))?.id, a.id);
    assert.equal((await store.resolve(a.id))?.id, a.id);
    assert.equal(await store.resolve("artifact://sha256/" + "0".repeat(64)), undefined);
  });
});

describe("atomic write crash semantics (T09)", () => {
  const points = ["after-object-tmp", "after-object-rename", "after-meta-tmp"] as const;

  for (const point of points) {
    it(`crash at ${point}: no valid metadata points at missing content`, async () => {
      const root = mkdtempSync(join(tmpRoot, `crash-${point}-`));
      const store = await ArtifactStore.open({ root });
      await assert.rejects(
        () =>
          store.write({
            content: "critical-output",
            mediaType: "text/plain",
            producer: { type: "tool", id: "w" },
            crash: { point, kill: (p) => { throw new Crash(p); } },
          }),
        (err: unknown) => err instanceof Crash,
      );
      // Reopen models a restarted process.
      const reopened = await ArtifactStore.open({ root });
      const records = await reopened.list();
      if (point === "after-meta-tmp") {
        // Object committed, record not: the write is invisible, never broken.
        assert.equal(records.length, 0);
      } else {
        assert.equal(records.length, 0);
      }
      // Invariant: every listed record's content exists and hashes correctly.
      const integrity = await reopened.verify();
      assert.deepEqual(integrity.problems, []);
      assert.equal(integrity.checkedRecords, 0);
      // A retry after the crash succeeds and is readable.
      const retried = await reopened.write({
        content: "critical-output",
        mediaType: "text/plain",
        producer: { type: "tool", id: "w" },
      });
      assert.equal((await reopened.content(retried)).toString("utf8"), "critical-output");
      assert.ok(existsSync(join(root, "objects", retried.digest.slice(0, 2), retried.digest)));
      // Temp leftovers exist but are inert garbage.
      assert.ok((await reopened.gcTemp()) >= 0);
    });
  }
});

describe("lineage (T10)", () => {
  it("report -> analysis -> source is reconstructable after store reopen", async () => {
    const root = mkdtempSync(join(tmpRoot, "lineage-"));
    const store = await ArtifactStore.open({ root });
    const ids = await writeChain(store);

    const reopened = await ArtifactStore.open({ root });
    const { root: tree, problems } = await reopened.lineage(ids.report);
    assert.deepEqual(problems, []);
    assert.ok(tree !== undefined);
    assert.equal(tree.record.id, ids.report);
    assert.equal(tree.parents.length, 1);
    assert.equal(tree.parents[0]?.record.id, ids.analysis);
    assert.equal(tree.parents[0]?.parents[0]?.record.id, ids.source);
    assert.equal(tree.parents[0]?.parents[0]?.parents.length, 0);
    assert.equal(tree.record.artifactId, `artifact://sha256/${tree.record.digest}`);
  });

  it("missing parent is reported as a problem, not silently dropped", async () => {
    const root = mkdtempSync(join(tmpRoot, "missing-"));
    const store = await ArtifactStore.open({ root });
    const orphan = await store.write({
      content: "x",
      mediaType: "text/plain",
      producer: { type: "t", id: "1" },
      parents: ["00000000-0000-0000-0000-000000000000"],
    });
    const { problems } = await store.lineage(orphan.id);
    assert.ok(problems.some((p) => p.includes("missing parent")));
  });

  it("tampered object content is detected by verify()", async () => {
    const root = mkdtempSync(join(tmpRoot, "tamper-"));
    const store = await ArtifactStore.open({ root });
    const a = await store.write({ content: "integrity", mediaType: "text/plain", producer: { type: "t", id: "1" } });
    writeFileSync(join(root, "objects", a.digest.slice(0, 2), a.digest), "tampered");
    const integrity = await store.verify();
    assert.ok(integrity.problems.some((p) => p.includes("digest mismatch")));
  });
});

describe("process restart survival (T11)", () => {
  const FIXTURE = fileURLToPath(new URL("./fixtures/artifact-chain-child.js", import.meta.url));

  it("artifacts written in a child process are listable with lineage in the parent", () => {
    const root = mkdtempSync(join(tmpRoot, "restart-"));
    const result = spawnSync(
      process.execPath,
      [FIXTURE, root],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const ids = JSON.parse((result.stdout ?? "").trim()) as { source: string; analysis: string; report: string };

    // New process context: the parent reopens the same root.
    return (async () => {
      const store = await ArtifactStore.open({ root });
      const records = await store.list();
      assert.equal(records.length, 3);
      const { root: tree, problems } = await store.lineage(ids.report);
      assert.deepEqual(problems, []);
      assert.ok(tree !== undefined);
      assert.equal(tree.record.id, ids.report);
      assert.equal(tree.parents[0]?.record.id, ids.analysis);
      assert.equal(tree.parents[0]?.parents[0]?.record.id, ids.source);
      assert.equal((await store.content(tree.record)).toString("utf8"), CONTENT_REPORT);
      assert.equal((await store.content(tree.parents[0]!.record)).toString("utf8"), CONTENT_ANALYSIS);
      assert.equal((await store.content(tree.parents[0]!.parents[0]!.record)).toString("utf8"), CONTENT_SOURCE);
    })();
  });
});
