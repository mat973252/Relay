/**
 * M4 capsule tests: machine-A -> machine-B migration with real effect
 * resume, interrupted export (T12), corruption rejection (T13), secret
 * isolation (T14), doctor-before-activation (T15), digest+lineage
 * preservation (T22), portable metadata (T23).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { exportCapsule, importCapsule } from "../src/capsule.js";
import { createTar, extractTar, gunzip, gzip, sha256Hex } from "../src/tar.js";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { ArtifactStore } from "@relay/artifact-fs";
import { CAPSULE_ROOT, validateManifest } from "@relay/core";

const EFFECT_CHILD = fileURLToPath(
  new URL("../../../storage-sqlite/dist/test/fixtures/effect-child.js", import.meta.url),
);
const COUNTER_PROVIDER = fileURLToPath(
  new URL("../../../storage-sqlite/dist/test/fixtures/counter-provider.js", import.meta.url),
);
const SECRET_VALUE = "relay-capsule-fake-secret-7c31d9";

const tmp = mkdtempSync(join(tmpdir(), "relay-capsule-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function seedWorkspace(dir: string): Promise<{ reportId: string }> {
  rmSync(dir, { recursive: true, force: true });
  const store = await ArtifactStore.open({ root: join(dir, ".relay", "artifacts") });
  const source = await store.write({
    content: "source-data",
    mediaType: "text/csv",
    producer: { type: "human", id: "author-1" },
  });
  const analysis = await store.write({
    content: "{\"n\":1}",
    mediaType: "application/json",
    producer: { type: "agent", id: "pi-1" },
    parents: [source.id],
  });
  const report = await store.write({
    content: "# report",
    mediaType: "text/markdown",
    producer: { type: "tool", id: "writer" },
    parents: [analysis.id],
  });
  writeFileSync(
    join(dir, ".env"),
    `RELAY_SECRET=${SECRET_VALUE}\n`,
  );
  writeFileSync(
    join(dir, "relay.capabilities.yaml"),
    [
      "schema: relay.capabilities/1",
      "capabilities:",
      "  - id: provider-token",
      "    required: true",
      "    check: { kind: env-ref, env: RELAY_TEST_SECRET_UNSET_XYZ }",
    ].join("\n"),
  );
  return { reportId: report.id };
}

async function spawnChild(args: string[]): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
    child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

const CLI_JS = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("capsule export/import (machine A -> machine B)", () => {
  it("preserves effects, artifacts, lineage, digests; secrets never packed (T14/T22/T23)", async () => {
    const machineA = join(tmp, "machine-a");
    const machineB = join(tmp, "machine-b");
    const { reportId } = await seedWorkspace(machineA);

    // Two effects: one CONFIRMED, one SUBMITTED (needs reconciliation).
    const journalA = await SqliteEffectJournal.open({ path: join(machineA, ".relay", "storage.db") });
    await journalA.insertPrepared({
      id: "eff-confirmed",
      key: "op/a",
      kind: "test",
      requestHash: "aa",
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: 1,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: 1,
    });
    await journalA.markSubmitted("eff-confirmed", 2);
    await journalA.markConfirmed("eff-confirmed", {
      remoteRef: "fx-1",
      resultJson: "{\"value\":1}",
      at: 3,
    });
    await journalA.insertPrepared({
      id: "eff-pending",
      key: "op/b",
      kind: "test",
      requestHash: "bb",
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: 4,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: 4,
    });
    await journalA.markSubmitted("eff-pending", 5);
    journalA.close();

    const capsulePath = join(tmp, "capsule.tar.gz");
    const exported = await exportCapsule({
      workspace: machineA,
      output: capsulePath,
      capabilitiesPath: join(machineA, "relay.capabilities.yaml"),
      adapterContextPath: await (async () => {
        const ctx = join(machineA, "pi-context.json");
        writeFileSync(ctx, JSON.stringify({ session: "pi-session-ref-1", runs: 3 }));
        return ctx;
      })(),
    });
    assert.ok(existsSync(capsulePath));
    assert.equal(exported.manifest.counts.effects, 2);
    assert.equal(exported.manifest.counts.artifactRecords, 3);

    // T14: capsule bytes contain neither the env secret nor the .env file.
    const capsuleBytes = readFileSync(capsulePath);
    assert.ok(!capsuleBytes.includes(Buffer.from(SECRET_VALUE, "utf8")), "secret leaked into capsule");
    const names = extractTar(gunzip(capsuleBytes)).map((entry) => entry.name);
    assert.ok(!names.some((name) => name.endsWith(".env")), ".env packed into capsule");

    // T23: every capsule path is relative POSIX; manifest validates.
    validateManifest(exported.manifest);
    assert.ok(names.every((name) => !name.startsWith("/") && !name.includes("\\")));

    // Import into machine B (fresh workspace).
    const imported = await importCapsule({ capsule: capsulePath, workspace: machineB });
    assert.deepEqual(
      imported.effectsPreserved.sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: "op/a", status: "CONFIRMED" },
        { key: "op/b", status: "SUBMITTED" },
      ],
    );

    // T22: same digests + reconstructable lineage in machine B.
    const storeB = await ArtifactStore.open({ root: join(machineB, ".relay", "artifacts") });
    const recordsB = await storeB.list();
    assert.equal(recordsB.length, 3);
    const { root: tree, problems } = await storeB.lineage(reportId);
    assert.deepEqual(problems, []);
    assert.ok(tree !== undefined);
    assert.equal(tree.parents.length, 1);
    assert.equal(tree.parents[0]?.parents.length, 1);
    assert.equal((await storeB.content(tree.record)).toString("utf8"), "# report");
    const storeA = await ArtifactStore.open({ root: join(machineA, ".relay", "artifacts") });
    const recordsA = await storeA.list();
    assert.deepEqual(
      recordsB.map((r) => r.digest).sort(),
      recordsA.map((r) => r.digest).sort(),
    );

    // Capabilities file and adapter context traveled along (the imported
    // contract now lives INSIDE .relay — single commit boundary).
    assert.ok(existsSync(join(machineB, ".relay", "relay.capabilities.yaml")));
    const packed = extractTar(gunzip(capsuleBytes));
    assert.ok(packed.some((entry) => entry.name === `${CAPSULE_ROOT}/adapter/context.json`));

    // Import is not activation: importing over a non-empty target is refused.
    await assert.rejects(
      () => importCapsule({ capsule: capsulePath, workspace: machineB }),
      /already holds/,
    );
    await importCapsule({ capsule: capsulePath, workspace: machineB, allowOverwrite: true });

    // T15 activation boundary: doctor resolves the contract committed with
    // .relay by the import — no explicit --capabilities, no root file needed.
    const doctorBlocked = await spawnChild([
      CLI_JS,
      "doctor",
      "--storage",
      join(machineB, ".relay", "storage.db"),
      "--artifacts",
      join(machineB, ".relay", "artifacts"),
    ]);
    assert.equal(doctorBlocked.status, 2, doctorBlocked.stdout + doctorBlocked.stderr);
    assert.match(doctorBlocked.stdout, /activation: BLOCKED/);
  });

  it("interrupted export leaves no valid capsule (T12)", async () => {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const machineA = join(tmp, `machine-t12-${fraction}`);
      await seedWorkspace(machineA);
      const capsulePath = join(tmp, `capsule-t12-${fraction}.tar.gz`);
      await assert.rejects(
        () =>
          exportCapsule({
            workspace: machineA,
            output: capsulePath,
            onEntry: (index, total) => {
              if (index / total >= fraction) {
                throw new Error(`simulated crash at ${String(fraction)}`);
              }
            },
          }),
        /simulated crash/,
      );
      assert.equal(existsSync(capsulePath), false, `partial capsule left at ${String(fraction)}`);
    }
  });

  it("corrupted or truncated capsule is rejected (T13)", async () => {
    const machineA = join(tmp, "machine-t13");
    await seedWorkspace(machineA);
    const capsulePath = join(tmp, "capsule-t13.tar.gz");
    await exportCapsule({ workspace: machineA, output: capsulePath });

    const target = join(tmp, "machine-t13-target");
    // Flip one byte in the middle of the archive.
    const bytes = readFileSync(capsulePath);
    const flipIndex = Math.floor(bytes.byteLength / 2);
    bytes[flipIndex] = (bytes[flipIndex] ?? 0) ^ 0xff;
    const corrupted = join(tmp, "capsule-t13-corrupt.tar.gz");
    writeFileSync(corrupted, bytes);
    await assert.rejects(
      () => importCapsule({ capsule: corrupted, workspace: target }),
      (err: unknown) => err instanceof Error,
    );

    // Truncation.
    const truncated = join(tmp, "capsule-t13-trunc.tar.gz");
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.byteLength / 3)));
    await assert.rejects(() => importCapsule({ capsule: truncated, workspace: target }));

    // Missing manifest.
    const notATar = join(tmp, "capsule-not-a.tar.gz");
    writeFileSync(notATar, "definitely not a capsule");
    await assert.rejects(() => importCapsule({ capsule: notATar, workspace: target }));
    assert.equal(existsSync(join(target, ".relay")), false);
  });

  it("rejects duplicate archive paths and unsafe artifact ids before staging", async () => {
    const source = join(tmp, "machine-untrusted");
    await seedWorkspace(source);
    const capsule = join(tmp, "capsule-untrusted.tar.gz");
    await exportCapsule({ workspace: source, output: capsule });
    const entries = extractTar(gunzip(readFileSync(capsule)));
    const target = join(tmp, "machine-untrusted-target");

    const duplicate = join(tmp, "capsule-duplicate.tar.gz");
    writeFileSync(duplicate, gzip(createTar([...entries, entries[0]!])));
    await assert.rejects(() => importCapsule({ capsule: duplicate, workspace: target }), /duplicate capsule entry/);

    const index = entries.find((entry) => entry.name === `${CAPSULE_ROOT}/artifacts/index.json`)!;
    const records = JSON.parse(index.data.toString("utf8")) as { id: string }[];
    records[0]!.id = "../../../../relay-escaped";
    index.data = Buffer.from(JSON.stringify(records));
    const manifestEntry = entries.find((entry) => entry.name === `${CAPSULE_ROOT}/manifest.json`)!;
    const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as { files: { path: string; sha256: string; byteSize: number }[] };
    const indexFile = manifest.files.find((file) => file.path === index.name)!;
    indexFile.sha256 = sha256Hex(index.data);
    indexFile.byteSize = index.data.byteLength;
    manifestEntry.data = Buffer.from(JSON.stringify(manifest));
    const unsafe = join(tmp, "capsule-unsafe-id.tar.gz");
    writeFileSync(unsafe, gzip(createTar(entries)));
    await assert.rejects(() => importCapsule({ capsule: unsafe, workspace: target }), /invalid artifact record/);
    assert.equal(existsSync(join(tmpdir(), "relay-escaped.json")), false);
  });

  it("migrated SUBMITTED effect resumes in machine B without duplicate remote work", { timeout: 120_000 }, async () => {
    const { startCounterProvider } = (await import(pathToFileURL(COUNTER_PROVIDER).href)) as {
      startCounterProvider: () => Promise<{
        baseUrl: string;
        state: () => { counter: number };
        stop: () => Promise<void>;
      }>;
    };
    const provider = await startCounterProvider();
    const machineA = join(tmp, "machine-a-live");
    const machineB = join(tmp, "machine-b-live");
    rmSync(machineA, { recursive: true, force: true });
    rmSync(machineB, { recursive: true, force: true });
    const dbA = join(machineA, ".relay", "storage.db");
    try {
      // Machine A: crash after the remote commit — journal SUBMITTED, counter=1.
      const crashed = await spawnChild([EFFECT_CHILD, dbA, provider.baseUrl, "after-remote-commit", "counter/live:1"]);
      assert.ok(
        crashed.signal === "SIGKILL" || (process.platform === "win32" && crashed.status !== 0),
        crashed.stderr,
      );

      const capsulePath = join(tmp, "capsule-live.tar.gz");
      await exportCapsule({ workspace: machineA, output: capsulePath });
      await importCapsule({ capsule: capsulePath, workspace: machineB });

      const journalB = await SqliteEffectJournal.open({ path: join(machineB, ".relay", "storage.db") });
      const record = await journalB.getByKey("counter/live:1");
      journalB.close();
      assert.ok(record !== undefined);
      assert.equal(record.status, "SUBMITTED");

      // Machine B resumes: reconcile finds the remote effect, confirms it.
      const resumed = await spawnChild([
        EFFECT_CHILD,
        join(machineB, ".relay", "storage.db"),
        provider.baseUrl,
        "none",
        "counter/live:1",
      ]);
      assert.equal(resumed.status, 0, resumed.stderr);
      const outcome = JSON.parse((resumed.stdout ?? "").trim()) as {
        status: string;
        reconciled?: boolean;
      };
      assert.equal(outcome.status, "confirmed");
      assert.equal(outcome.reconciled, true);
      assert.equal(provider.state().counter, 1, "duplicate remote effect after migration");
    } finally {
      await provider.stop();
    }
  });
});

describe("M6 import crash matrix (all-or-nothing workspace swap)", () => {
  async function seedOldState(dir: string): Promise<void> {
    const journal = await SqliteEffectJournal.open({ path: join(dir, ".relay", "storage.db") });
    try {
      await journal.insertPrepared({
        id: "old-1",
        key: "old/op",
        kind: "old",
        requestHash: "00",
        replay: "never",
        status: "PREPARED",
        remoteRef: undefined,
        resultJson: undefined,
        reason: undefined,
        createdAt: 1,
        submittedAt: undefined,
        settledAt: undefined,
        updatedAt: 1,
      });
      await journal.markSubmitted("old-1", 2);
    } finally {
      journal.close();
    }
    const store = await ArtifactStore.open({ root: join(dir, ".relay", "artifacts") });
    await store.write({
      content: "old-artifact",
      mediaType: "text/plain",
      producer: { type: "tool", id: "old" },
    });
  }

  async function journalKeys(dir: string): Promise<string[]> {
    const journal = await SqliteEffectJournal.open({ path: join(dir, ".relay", "storage.db") });
    try {
      return (await journal.list()).map((r) => r.key);
    } finally {
      journal.close();
    }
  }

  const crashPoints = ["after-validation", "after-stage", "after-old-swap", "after-commit"] as const;

  for (const point of crashPoints) {
    it(`crash at ${point} leaves a consistent (old | parked-old | new) workspace`, async () => {
      const machineA = join(tmp, `m6-src-${point}`);
      await seedWorkspace(machineA);
      const capsulePath = join(tmp, `m6-capsule-${point}.tar.gz`);
      await exportCapsule({ workspace: machineA, output: capsulePath });

      const target = join(tmp, `m6-target-${point}`);
      await seedOldState(target);

      const crash = {
        point,
        kill: (p: string) => {
          throw new Error(`simulated crash at ${p}`);
        },
      };
      if (point === "after-commit") {
        await assert.rejects(
          () => importCapsule({ capsule: capsulePath, workspace: target, allowOverwrite: true, crash }),
          /simulated crash/,
        );
        // The caller died, but the workspace swap fully committed: the new
        // artifact registry replaced the old one and no parked old dir stays.
        const store = await ArtifactStore.open({ root: join(target, ".relay", "artifacts") });
        const records = await store.list();
        assert.equal(records.length, 3, "imported artifact records missing after commit crash");
        assert.ok((await store.verify()).problems.length === 0);
        assert.equal(existsSync(join(target, ".relay.pre-import-old")), false, "parked old state must be cleaned");
      } else {
        await assert.rejects(
          () => importCapsule({ capsule: capsulePath, workspace: target, allowOverwrite: true, crash }),
          /simulated crash/,
        );
        if (point === "after-old-swap") {
          // Old state parked intact; recoverable by renaming back.
          assert.equal(existsSync(join(target, ".relay")), false, "half-swapped .relay must not exist");
          assert.ok(existsSync(join(target, ".relay.pre-import-old", "storage.db")));
          await renameSync(join(target, ".relay.pre-import-old"), join(target, ".relay"));
          assert.deepEqual(await journalKeys(target), ["old/op"]);
        } else {
          // Old state fully intact.
          assert.deepEqual(await journalKeys(target), ["old/op"]);
          const store = await ArtifactStore.open({ root: join(target, ".relay", "artifacts") });
          assert.equal((await store.list()).length, 1);
        }
      }
    });
  }
});

function renameSync(from: string, to: string): Promise<void> {
  return import("node:fs/promises").then((fs) => fs.rename(from, to));
}

describe("M7 import/capability coherence (single commit boundary)", () => {
  const OLD_SECRET_ENV = "RELAY_OLD_CAP_SET";
  const NEW_UNSET_ENV = "RELAY_NEW_CAP_UNSET";

  /** Old contract: required secret that IS set -> doctor READY (exit 0) when it governs. */
  function writeOldContract(dir: string): void {
    writeFileSync(
      join(dir, "relay.capabilities.yaml"),
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: old-provider-token",
        "    required: true",
        `    check: { kind: env-ref, env: ${OLD_SECRET_ENV} }`,
      ].join("\n"),
    );
  }

  function capsuleContract(): string {
    // New contract: required secret that is NEVER set -> doctor BLOCKED (exit 2)
    // when it governs. Different capability id than the old one.
    return [
      "schema: relay.capabilities/1",
      "capabilities:",
      "  - id: new-provider-token",
      "    required: true",
      `    check: { kind: env-ref, env: ${NEW_UNSET_ENV} }`,
    ].join("\n");
  }

  async function seedTarget(dir: string): Promise<void> {
    const journal = await SqliteEffectJournal.open({ path: join(dir, ".relay", "storage.db") });
    try {
      await journal.insertPrepared({
        id: "old-1",
        key: "old/op",
        kind: "old",
        requestHash: "00",
        replay: "never",
        status: "PREPARED",
        remoteRef: undefined,
        resultJson: undefined,
        reason: undefined,
        createdAt: 1,
        submittedAt: undefined,
        settledAt: undefined,
        updatedAt: 1,
      });
      await journal.markSubmitted("old-1", 2);
      await journal.markConfirmed("old-1", { remoteRef: "old-r", resultJson: "null", at: 3 });
    } finally {
      journal.close();
    }
    const store = await ArtifactStore.open({ root: join(dir, ".relay", "artifacts") });
    await store.write({
      content: "old-artifact",
      mediaType: "text/plain",
      producer: { type: "tool", id: "old" },
    });
    writeOldContract(dir);
  }

  async function buildCapsule(dir: string, withContract: boolean): Promise<string> {
    const src = join(dir, "src");
    const store = await ArtifactStore.open({ root: join(src, ".relay", "artifacts") });
    await store.write({
      content: "new-artifact",
      mediaType: "text/plain",
      producer: { type: "tool", id: "new" },
    });
    const journal = await SqliteEffectJournal.open({ path: join(src, ".relay", "storage.db") });
    try {
      await journal.insertPrepared({
        id: "new-1",
        key: "new/op",
        kind: "new",
        requestHash: "11",
        replay: "never",
        status: "PREPARED",
        remoteRef: undefined,
        resultJson: undefined,
        reason: undefined,
        createdAt: 1,
        submittedAt: undefined,
        settledAt: undefined,
        updatedAt: 1,
      });
      await journal.markSubmitted("new-1", 2);
      await journal.markConfirmed("new-1", { remoteRef: "new-r", resultJson: "null", at: 3 });
    } finally {
      journal.close();
    }
    let capabilitiesPath: string | undefined;
    if (withContract) {
      capabilitiesPath = join(src, "relay.capabilities.yaml");
      writeFileSync(capabilitiesPath, capsuleContract());
    }
    const capsule = join(dir, "capsule.tar.gz");
    await exportCapsule({ workspace: src, output: capsule, capabilitiesPath });
    return capsule;
  }

  /** 0 = old/no contract governs (READY); 2 = imported new contract governs (BLOCKED). */
  function doctorExit(target: string): number {
    const result = spawnSync(
      process.execPath,
      [
        CLI_JS,
        "doctor",
        "--storage",
        join(target, ".relay", "storage.db"),
        "--artifacts",
        join(target, ".relay", "artifacts"),
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, [OLD_SECRET_ENV]: "old-contract-secret-set" },
      },
    );
    return result.status ?? -1;
  }

  async function journalKeys(dir: string): Promise<string[]> {
    const db = join(dir, ".relay", "storage.db");
    if (!existsSync(db)) return [];
    const journal = await SqliteEffectJournal.open({ path: db });
    try {
      return (await journal.list()).map((r) => r.key);
    } finally {
      journal.close();
    }
  }

  async function assertOldPair(target: string): Promise<void> {
    assert.deepEqual(await journalKeys(target), ["old/op"]);
    assert.equal(existsSync(join(target, ".relay", "relay.capabilities.yaml")), false);
    assert.match(readFileSync(join(target, "relay.capabilities.yaml"), "utf8"), /old-provider-token/);
    assert.equal(doctorExit(target), 0, "old pair must remain doctor-READY");
  }

  async function assertNewPair(target: string): Promise<void> {
    assert.deepEqual(await journalKeys(target), ["new/op"]);
    const imported = join(target, ".relay", "relay.capabilities.yaml");
    assert.ok(existsSync(imported), "imported contract must live inside .relay");
    assert.match(readFileSync(imported, "utf8"), /new-provider-token/);
    assert.equal(doctorExit(target), 2, "new pair must resolve the imported contract (BLOCKED, never READY)");
  }

  async function importWith(capsule: string, target: string, point: string): Promise<unknown> {
    return importCapsule({
      capsule,
      workspace: target,
      allowOverwrite: true,
      crash: { point: point as never, kill: (p: string) => { throw new Error(`crash at ${p}`); } },
    });
  }

  it("successful import pairs new state with the imported contract in one .relay commit", async () => {
    const base = join(tmp, "m7-ok-");
    const target = mkdtempSync(base);
    await seedTarget(target);
    const capsule = await buildCapsule(target, true);
    await importCapsule({ capsule, workspace: target, allowOverwrite: true });
    await assertNewPair(target);
    assert.equal(existsSync(join(target, ".relay.pre-import-old")), false);
  });

  it("requires --overwrite when the target has artifacts or a contract but no effects", async () => {
    const target = mkdtempSync(join(tmp, "m7-artifacts-only-"));
    const store = await ArtifactStore.open({ root: join(target, ".relay", "artifacts") });
    await store.write({ content: "keep-me", mediaType: "text/plain", producer: { type: "tool", id: "old" } });
    writeFileSync(join(target, ".relay", "relay.capabilities.yaml"), capsuleContract());
    const capsule = await buildCapsule(target, true);
    await assert.rejects(() => importCapsule({ capsule, workspace: target }), /already holds Relay state/);
    assert.equal((await store.list()).length, 1);
    assert.ok(existsSync(join(target, ".relay", "relay.capabilities.yaml")));
  });

  it("capsule without a contract imports state only; old root contract keeps governing", async () => {
    const target = mkdtempSync(join(tmp, "m7-nocontract-"));
    await seedTarget(target);
    const capsule = await buildCapsule(target, false);
    await importCapsule({ capsule, workspace: target, allowOverwrite: true });
    assert.deepEqual(await journalKeys(target), ["new/op"]);
    assert.equal(existsSync(join(target, ".relay", "relay.capabilities.yaml")), false);
    assert.equal(doctorExit(target), 0, "no imported contract -> old root contract governs");
  });

  const interrupted = ["after-validation", "after-stage", "after-relay-commit", "after-commit"] as const;
  for (const point of interrupted) {
    it(`death at ${point}: the governing pair never mixes`, async () => {
      const target = mkdtempSync(join(tmp, `m7-${point}-`));
      await seedTarget(target);
      const capsule = await buildCapsule(target, true);
      await assert.rejects(() => importWith(capsule, target, point), /crash at/);
      if (point === "after-validation" || point === "after-stage") {
        await assertOldPair(target);
      } else {
        // after-relay-commit and after-commit both have the new .relay (with
        // its contract) installed: the pair must be new-new, never new-old.
        await assertNewPair(target);
      }
      // Recovery: a later import attempt completes to the new pair.
      await importCapsule({ capsule, workspace: target, allowOverwrite: true });
      await assertNewPair(target);
    });
  }

  it("death after parking old state recovers the old pair, then a retry imports coherently", async () => {
    const target = mkdtempSync(join(tmp, "m7-parked-"));
    await seedTarget(target);
    const capsule = await buildCapsule(target, true);
    await assert.rejects(() => importWith(capsule, target, "after-old-swap"), /crash at/);
    assert.equal(existsSync(join(target, ".relay")), false);
    assert.ok(existsSync(join(target, ".relay.pre-import-old")));
    // Documented recovery: the next import restores the parked state first.
    await importCapsule({ capsule, workspace: target, allowOverwrite: true });
    await assertNewPair(target);
  });

  it("restores parked state before enforcing --overwrite on retry", async () => {
    const target = mkdtempSync(join(tmp, "m7-parked-guard-"));
    await seedTarget(target);
    const capsule = await buildCapsule(target, true);
    await assert.rejects(() => importWith(capsule, target, "after-old-swap"), /crash at/);
    await assert.rejects(() => importCapsule({ capsule, workspace: target }), /already holds Relay state/);
    await assertOldPair(target);
    assert.equal(existsSync(join(target, ".relay.pre-import-old")), false);
  });

  it("unwritable workspace fails the import without touching the old pair", async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip("chmod does not reliably deny writes for this process");
      return;
    }
    const target = mkdtempSync(join(tmp, "m7-ro-"));
    await seedTarget(target);
    const capsule = await buildCapsule(target, true);
    const { chmod } = await import("node:fs/promises");
    await chmod(target, 0o555);
    try {
      await assert.rejects(
        () => importCapsule({ capsule, workspace: target, allowOverwrite: true }),
        (err: unknown) => err instanceof Error,
      );
    } finally {
      await chmod(target, 0o755);
    }
    await assertOldPair(target);
  });
});
