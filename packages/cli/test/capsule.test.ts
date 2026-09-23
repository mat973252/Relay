/**
 * M4 capsule tests: machine-A -> machine-B migration with real effect
 * resume, interrupted export (T12), corruption rejection (T13), secret
 * isolation (T14), doctor-before-activation (T15), digest+lineage
 * preservation (T22), portable metadata (T23).
 */
import assert from "node:assert/strict";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { exportCapsule, importCapsule } from "../src/capsule.js";
import { extractTar, gunzip } from "../src/tar.js";
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

    // Capabilities file and adapter context traveled along.
    assert.ok(existsSync(join(machineB, "relay.capabilities.yaml")));
    const packed = extractTar(gunzip(capsuleBytes));
    assert.ok(packed.some((entry) => entry.name === `${CAPSULE_ROOT}/adapter/context.json`));

    // Import is not activation: importing over a non-empty target is refused.
    await assert.rejects(
      () => importCapsule({ capsule: capsulePath, workspace: machineB }),
      /already holds/,
    );
    await importCapsule({ capsule: capsulePath, workspace: machineB, allowOverwrite: true });

    // T15 activation boundary: doctor evaluates the imported capability
    // contract in the target workspace — blocked until the secret exists.
    const doctorBlocked = await spawnChild([
      CLI_JS,
      "doctor",
      "--storage",
      join(machineB, ".relay", "storage.db"),
      "--artifacts",
      join(machineB, ".relay", "artifacts"),
      "--capabilities",
      join(machineB, "relay.capabilities.yaml"),
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

  it("migrated SUBMITTED effect resumes in machine B without duplicate remote work", { timeout: 120_000 }, async () => {
    const { startCounterProvider } = (await import(COUNTER_PROVIDER)) as {
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
      assert.equal(crashed.signal, "SIGKILL", crashed.stderr);

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
