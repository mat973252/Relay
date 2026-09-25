/**
 * MCP safety-review regression tests (tasks/NEXT_ITERATION_MCP_SAFETY_FIXES.md):
 *
 *  - same-key calls through one owner must linearize: an in-flight execution
 *    must never be settled FAILED by a concurrent not-found observation;
 *  - relay_reconcile_operation must be read-only for absent/PREPARED keys
 *    (no row creation, no remote request);
 *  - provider outcomes default to UNKNOWN: commit-then-409/408 and
 *    never-answering requests are ambiguous, not definitive failures
 *    (timeouts stay bounded but never become FAILED);
 *  - recovery binds to a stable, observable operation: list exposes
 *    actionId/operationId/intent; action-config changes invalidate request
 *    identity; endpoints must actually bind {operationId}.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import { startMiniProvider } from "./fixtures/mini-provider.js";
import { hashRequest } from "@relay/core";
import { randomUUID } from "node:crypto";
import {
  connectClient,
  journalRecord,
  journalStatus,
  makeTempRoot,
  makeWorkspace,
  writeActions,
  writeRawActions,
  MAIN,
} from "./helpers.js";

const tmp = makeTempRoot("relay-mcp-safety-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const ACTION = "counter-increment";

describe("same-key linearization within the owner", () => {
  it("two concurrent submissions of one operation id: no false FAILED, counter 1, both confirmed", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ preCommitHoldMs: 2_500 });
    const workspace = makeWorkspace(tmp, "linear2");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      // Fire both without awaiting the first: the second must NOT observe the
      // in-flight SUBMITTED state and settle it FAILED via reconcile.
      const first = client.call("relay_submit_action", { actionId: ACTION, operationId: "op-linear" });
      const second = client.call("relay_submit_action", { actionId: ACTION, operationId: "op-linear" });
      const [r1, r2] = await Promise.all([first, second]);
      assert.equal(r1.isError, false, r1.text);
      assert.equal(r2.isError, false, r2.text);
      assert.match(r1.text, /"status":"confirmed"/);
      assert.match(r2.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1, "remote effect executed exactly once");
      assert.equal(await journalStatus(workspace, `${ACTION}:op-linear`), "CONFIRMED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("reconcile racing an in-flight submission waits for it instead of marking FAILED", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ preCommitHoldMs: 2_500 });
    const workspace = makeWorkspace(tmp, "linearrec");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const submit = client.call("relay_submit_action", { actionId: ACTION, operationId: "op-race" });
      await new Promise((r) => setTimeout(r, 400)); // submission is in flight (pre-commit)
      const rec = client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-race" });
      const [sub, reconcile] = await Promise.all([submit, rec]);
      assert.equal(sub.isError, false, sub.text);
      assert.equal(reconcile.isError, false, reconcile.text);
      assert.match(reconcile.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-race`), "CONFIRMED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("reconcile is non-creating and read-only for unsettled-local states", () => {
  it("absent key: explicit absent result, no journal row, no remote request", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider();
    const workspace = makeWorkspace(tmp, "absent");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "ghost-op" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /absent/i);
      assert.equal(await journalRecord(workspace, `${ACTION}:ghost-op`), undefined, "reconcile must not create a journal row");
      assert.deepEqual(
        provider.requests().filter((r) => r.includes("ghost-op")),
        [],
        "reconcile must not contact the provider for an absent key",
      );
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("PREPARED key: explicit result, row stays PREPARED, no remote request", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider();
    const workspace = makeWorkspace(tmp, "prepared");
    writeActions(workspace, provider.baseUrl);
    // Seed a PREPARED row directly (execution never began).
    const { SqliteEffectJournal } = await import("@relay/storage-sqlite");
    const journal = await SqliteEffectJournal.open({ path: `${workspace}/.relay/storage.db` });
    const now = Date.now();
    await journal.insertPrepared({
      id: randomUUID(),
      key: `${ACTION}:op-prep`,
      kind: `mcp:${ACTION}`,
      requestHash: hashRequest({ actionId: ACTION, operationId: "op-prep" }),
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: now,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: now,
    });
    journal.close();

    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-prep" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /PREPARED/i);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-prep`), "PREPARED", "reconcile must not mutate a PREPARED row");
      assert.equal(provider.counter(), 0);
      assert.deepEqual(
        provider.requests().filter((r) => r.includes("op-prep")),
        [],
        "reconcile must not contact the provider for a PREPARED key",
      );
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("ambiguous provider outcomes default to UNKNOWN", () => {
  for (const status of [409, 408]) {
    it(`provider commits then answers ${String(status)}: UNKNOWN (not FAILED), then reconcile confirms`, { timeout: 60_000 }, async () => {
      const provider = await startMiniProvider({ commitStatus: status });
      const workspace = makeWorkspace(tmp, `commit${String(status)}`);
      writeActions(workspace, provider.baseUrl);
      const client = await connectClient(workspace);
      try {
        const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: `op-${String(status)}` });
        assert.equal(res.isError, false, res.text);
        const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
        assert.equal(outcome.status, "unknown", `commit-then-${String(status)} is ambiguous, not definitive`);
        assert.match(res.text, /do NOT resubmit/i);
        assert.equal(provider.counter(), 1, "the remote effect DID happen");
        assert.equal(await journalStatus(workspace, `${ACTION}:op-${String(status)}`), "UNKNOWN");

        const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: `op-${String(status)}` });
        assert.equal(rec.isError, false, rec.text);
        assert.match(rec.text, /"status":"confirmed"/);
        assert.equal(provider.counter(), 1, "reconcile is read-only");
      } finally {
        client.kill();
        await client.exit;
        await provider.stop();
      }
    });
  }

  it("a request that never responds resolves UNKNOWN within the configured timeout (bounded, not FAILED)", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ neverRespond: true });
    const workspace = makeWorkspace(tmp, "never");
    writeActions(workspace, provider.baseUrl, { timeoutMs: 400 });
    const client = await connectClient(workspace);
    try {
      const started = Date.now();
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-never" });
      const elapsed = Date.now() - started;
      assert.equal(res.isError, false, res.text);
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", "no definitive answer means UNKNOWN");
      assert.ok(elapsed < 10_000, `timeout must be bounded by configuration (took ${String(elapsed)}ms)`);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-never`), "UNKNOWN", "timeout must never settle as FAILED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("a status the operator configured as proven pre-commit rejection is a definitive FAILED", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ commitStatus: 422 }); // e.g. validation rejection semantics
    const workspace = makeWorkspace(tmp, "reject");
    writeActions(workspace, provider.baseUrl, { rejectStatuses: [422] });
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-reject" });
      assert.equal(res.isError, true, "configured rejection is a definitive failure");
      assert.match(res.text, /"status":"failed"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-reject`), "FAILED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("recovery binds to a stable, observable operation", () => {
  it("relay_list_unresolved exposes actionId, operationId, and intent for a fresh session", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ commitStatus: 409 });
    const workspace = makeWorkspace(tmp, "observable");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    const operationId = "invoice-import:2027-03-01-batch-042";
    try {
      const res = await client.call("relay_submit_action", {
        actionId: ACTION,
        operationId,
        intent: "March invoice import for ACME",
      });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /"status":"unknown"/);

      const list = await client.call("relay_list_unresolved", {});
      const entries = JSON.parse(list.text) as Array<Record<string, unknown>>;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.actionId, ACTION);
      assert.equal(entries[0]!.operationId, operationId);
      assert.equal(entries[0]!.status, "UNKNOWN");
      assert.equal(entries[0]!.intent, "March invoice import for ACME");
    } finally {
      client.kill();
      await client.exit;
    }

    // A genuinely fresh session (new process after lock release-on-death)
    // recovers from the list alone.
    const clientB = await connectClient(workspace);
    try {
      const list = await clientB.call("relay_list_unresolved", {});
      const entries = JSON.parse(list.text) as Array<Record<string, unknown>>;
      assert.equal(entries[0]!.operationId, operationId);
      assert.equal(entries[0]!.intent, "March invoice import for ACME");
      const rec = await clientB.call("relay_reconcile_operation", { actionId: ACTION, operationId });
      assert.match(rec.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1);
    } finally {
      clientB.kill();
      await clientB.exit;
      await provider.stop();
    }
  });

  it("changing the action's remote meaning rejects reuse of the same operation id", { timeout: 90_000 }, async () => {
    const providerA = await startMiniProvider();
    const providerB = await startMiniProvider();
    const workspace = makeWorkspace(tmp, "configchange");
    writeActions(workspace, providerA.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-config", intent: "v1 endpoint" });
      assert.match(res.text, /"status":"confirmed"/);
      assert.equal(providerA.counter(), 1);
    } finally {
      client.kill();
      await client.exit;
    }

    // Same action id, different remote meaning (new destination).
    writeActions(workspace, providerB.baseUrl);
    const client2 = await connectClient(workspace);
    try {
      const res = await client2.call("relay_submit_action", { actionId: ACTION, operationId: "op-config", intent: "v1 endpoint" });
      assert.equal(res.isError, true, "request identity must be bound to the action's remote meaning");
      assert.match(res.text, /different effect/);
      assert.equal(providerB.counter(), 0, "no submission to the new destination");
      assert.equal(await journalStatus(workspace, `${ACTION}:op-config`), "CONFIRMED", "journal untouched");
    } finally {
      client2.kill();
      await client2.exit;
      await providerA.stop();
      await providerB.stop();
    }
  });

  it("endpoints that do not bind {operationId} are rejected at config load (exit 78)", { timeout: 30_000 }, async () => {
    const provider = await startMiniProvider();
    await provider.stop();
    for (const doc of [
      {
        schema: "relay.mcp-actions/1",
        actions: [
          {
            id: "no-bind",
            label: "execute endpoint without operation id binding",
            http: { url: `${provider.baseUrl}/increment`, method: "POST" },
            reconcile: { url: `${provider.baseUrl}/effects/{operationId}`, shape: "found-flag" },
          },
        ],
      },
      {
        schema: "relay.mcp-actions/1",
        actions: [
          {
            id: "no-bind-rec",
            label: "reconcile endpoint without operation id binding",
            http: { url: `${provider.baseUrl}/increment?operationId={operationId}`, method: "POST" },
            reconcile: { url: `${provider.baseUrl}/effects/latest`, shape: "found-flag" },
          },
        ],
      },
    ]) {
      const workspace = makeWorkspace(tmp, "nobind");
      writeRawActions(workspace, doc);
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [MAIN, "--workspace", workspace], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (status) => resolve({ status, stderr }));
      });
      assert.equal(result.status, 78, `expected config refusal, stderr: ${result.stderr}`);
      assert.match(result.stderr, /operationId/);
    }
  });
});
