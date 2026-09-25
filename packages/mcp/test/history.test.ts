/**
 * Effect transition evidence through the MCP surface: the append-only
 * history must equal what the fake provider actually observed — one prepare
 * per operation under same-key concurrency, one reconcile event per
 * read-only reconcile call, no transition for a deduplicated re-entry, and
 * status/history agreement across a server restart.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import type { EffectHistory } from "@relay/core";
import { startMiniProvider } from "./fixtures/mini-provider.js";
import { startPendingProvider } from "./fixtures/pending-provider.js";
import { connectClient, makeTempRoot, makeWorkspace, writeActions, writeRawActions } from "./helpers.js";

const tmp = makeTempRoot("relay-mcp-history-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const ACTION = "counter-increment";

async function history(workspace: string, key: string): Promise<EffectHistory> {
  const journal = await SqliteEffectJournal.open({ path: join(workspace, ".relay", "storage.db") });
  try {
    const [h] = await journal.listHistory(key);
    assert.ok(h !== undefined, `no history for ${key}`);
    assert.equal(h.events.at(-1)?.toStatus, h.record.status, "status/history contradiction");
    return h;
  } finally {
    journal.close();
  }
}

const shape = (h: EffectHistory) => h.events.map((e) => `${e.fromStatus ?? "-"}>${e.toStatus}:${e.cause}`);

describe("effect transition evidence via MCP", () => {
  it("same-key concurrent submits: one prepare, one submit, one execute-confirm; no duplicate transitions", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ preCommitHoldMs: 1_500 });
    const workspace = makeWorkspace(tmp, "hist-linear");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const [r1, r2] = await Promise.all([
        client.call("relay_submit_action", { actionId: ACTION, operationId: "op-h1" }),
        client.call("relay_submit_action", { actionId: ACTION, operationId: "op-h1" }),
      ]);
      assert.match(r1.text, /"status":"confirmed"/);
      assert.match(r2.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1);
      const h = await history(workspace, `${ACTION}:op-h1`);
      assert.equal(h.coverage, "observed");
      assert.deepEqual(shape(h), ["->PREPARED:prepare", "PREPARED>SUBMITTED:submit", "SUBMITTED>CONFIRMED:execute"]);
      assert.equal(h.events.filter((e) => e.toStatus === "CONFIRMED").length, provider.counter());

      // A later dedup re-entry and a get are not transitions.
      const again = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-h1" });
      assert.match(again.text, /"deduplicated":true/);
      await client.call("relay_get_operation", { actionId: ACTION, operationId: "op-h1" });
      assert.equal((await history(workspace, `${ACTION}:op-h1`)).events.length, 3);
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("repeated read-only reconcile of an UNKNOWN operation appends exactly one reconcile event per observation", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 202 });
    const workspace = makeWorkspace(tmp, "hist-pending");
    writeRawActions(workspace, {
      schema: "relay.mcp-actions/1",
      actions: [
        {
          id: ACTION,
          label: "Async counter increment",
          http: { url: `${provider.baseUrl}/increment?operationId={operationId}`, method: "POST" },
          reconcile: { url: `${provider.baseUrl}/effects/{operationId}`, shape: "status-field" },
        },
      ],
    });
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-h2" });
      assert.match(res.text, /"status":"unknown"/);
      for (let i = 0; i < 3; i += 1) {
        const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-h2" });
        assert.match(rec.text, /"status":"unknown"/);
      }
      const h = await history(workspace, `${ACTION}:op-h2`);
      assert.equal(h.record.status, "UNKNOWN");
      assert.deepEqual(shape(h), [
        "->PREPARED:prepare",
        "PREPARED>SUBMITTED:submit",
        "SUBMITTED>UNKNOWN:execute",
        "UNKNOWN>UNKNOWN:reconcile",
        "UNKNOWN>UNKNOWN:reconcile",
        "UNKNOWN>UNKNOWN:reconcile",
      ]);
      const gets = provider.requests().filter((r) => r.startsWith("GET")).length;
      assert.equal(h.events.filter((e) => e.cause === "reconcile").length, gets, "one reconcile event per provider observation");
      assert.equal(provider.requests().filter((r) => r.startsWith("POST")).length, 1);
      assert.equal(provider.counter(), 0);
      assert.ok(h.events.every((e) => e.toStatus !== "CONFIRMED"), "no confirmation without proof");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("server killed mid-flight, restarted: history has no invented recovery event and agrees with the row", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider({ preCommitHoldMs: 3_000 });
    const workspace = makeWorkspace(tmp, "hist-restart");
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    const pending = client.call("relay_submit_action", { actionId: ACTION, operationId: "op-h3" });
    await new Promise((r) => setTimeout(r, 600));
    client.kill();
    await client.exit;
    void pending; // never answered: the server died mid-flight
    const afterCrash = await history(workspace, `${ACTION}:op-h3`);
    assert.equal(afterCrash.record.status, "SUBMITTED");
    assert.deepEqual(shape(afterCrash), ["->PREPARED:prepare", "PREPARED>SUBMITTED:submit"]);

    // Let the provider finish committing (it commits after the hold), then reconcile from a fresh server.
    await new Promise((r) => setTimeout(r, 3_000));
    const fresh = await connectClient(workspace);
    try {
      const rec = await fresh.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-h3" });
      const outcome = JSON.parse(rec.text) as { status: string; reconciled?: boolean };
      const h = await history(workspace, `${ACTION}:op-h3`);
      assert.equal(h.events.length, 3);
      const last = h.events[2]!;
      assert.equal(last.cause, "reconcile");
      assert.equal(last.fromStatus, "SUBMITTED");
      if (outcome.status === "confirmed") {
        assert.equal(provider.counter(), 1);
        assert.equal(last.toStatus, "CONFIRMED");
      } else {
        assert.equal(outcome.status, "failed");
        assert.equal(provider.counter(), 0);
        assert.equal(last.toStatus, "FAILED");
      }
    } finally {
      fresh.kill();
      await fresh.exit;
      await provider.stop();
    }
  });
});
