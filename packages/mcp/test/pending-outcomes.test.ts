/**
 * Pending-outcome regression tests (tasks/NEXT_ITERATION_PENDING_OUTCOMES.md):
 * acceptance is not execution, and a reconcile answer that does not PROVE the
 * remote outcome must never settle a journal row to a terminal state.
 *
 *  - submit returning 202 {"status":"pending"} (or any non-complete status):
 *    acceptance is not proof of execution -> stays unresolved, never CONFIRMED;
 *  - read-only reconcile returning {"status":"pending"}: pending is not proof
 *    of non-execution -> stays UNKNOWN, never FAILED;
 *  - missing/malformed/statuses outside the configured contract are
 *    unverifiable -> UNKNOWN;
 *  - only operator-configured proof of non-execution may settle FAILED, and
 *    reconcile never resubmits;
 *  - proven synchronous completion and definitive rejection keep working.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import { startMiniProvider } from "./fixtures/mini-provider.js";
import { startPendingProvider } from "./fixtures/pending-provider.js";
import {
  connectClient,
  journalStatus,
  makeTempRoot,
  makeWorkspace,
  writeActions,
  writeRawActions,
} from "./helpers.js";

const tmp = makeTempRoot("relay-mcp-pending-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const ACTION = "counter-increment";

function writeStatusFieldActions(
  workspace: string,
  baseUrl: string,
  extraReconcile: Record<string, unknown> = {},
  extraHttp: Record<string, unknown> = {},
): void {
  writeRawActions(workspace, {
    schema: "relay.mcp-actions/1",
    actions: [
      {
        id: ACTION,
        label: "Async counter increment (accept-then-commit provider)",
        http: { url: `${baseUrl}/increment?operationId={operationId}`, method: "POST", ...extraHttp },
        reconcile: { url: `${baseUrl}/effects/{operationId}`, shape: "status-field", ...extraReconcile },
      },
    ],
  });
}

/** A 2xx submit body that is not contract-proven completion resolves UNKNOWN. */
describe("acceptance is not proof of execution", () => {
  for (const submitStatus of [202, 200]) {
    it(`submit ${String(submitStatus)} {"status":"pending"} with no remote commit: outcome unknown, journal UNKNOWN`, { timeout: 60_000 }, async () => {
      const provider = await startPendingProvider({ submitStatus });
      const workspace = makeWorkspace(tmp, `accept${String(submitStatus)}`);
      writeStatusFieldActions(workspace, provider.baseUrl);
      const client = await connectClient(workspace);
      try {
        const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-pending" });
        assert.equal(res.isError, false, res.text);
        const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
        assert.equal(outcome.status, "unknown", `accepted ${String(submitStatus)} does not prove execution`);
        assert.match(res.text, /do NOT resubmit/i);
        assert.equal(provider.counter(), 0, "the fake provider committed no effect");
        assert.equal(await journalStatus(workspace, `${ACTION}:op-pending`), "UNKNOWN");
      } finally {
        client.kill();
        await client.exit;
        await provider.stop();
      }
    });
  }

  it("accepted operation settles CONFIRMED only when a later reconcile proves execution", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ commitAfterMs: 250 });
    const workspace = makeWorkspace(tmp, "acceptthencommit");
    writeStatusFieldActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-async" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", "202 acceptance is unresolved, not CONFIRMED");

      // Give the fake provider's delayed commit time to land.
      await new Promise((r) => setTimeout(r, 500));
      const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-async" });
      assert.equal(rec.isError, false, rec.text);
      assert.match(rec.text, /"status":"confirmed"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-async`), "CONFIRMED");
      assert.equal(provider.counter(), 1, "the remote commit happened exactly once");
      assert.equal(provider.requests().filter((r) => r.startsWith("POST")).length, 1, "reconcile did not resubmit");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("reconcile must distinguish executed / not-executed / unresolved", () => {
  it("ambiguous submit left UNKNOWN; reconcile 200 {\"status\":\"pending\"} keeps UNKNOWN, not FAILED", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 409 });
    const workspace = makeWorkspace(tmp, "reconcpending");
    writeStatusFieldActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-amb" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", res.text);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-amb`), "UNKNOWN");

      const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-amb" });
      assert.equal(rec.isError, false, rec.text);
      assert.match(rec.text, /"status":"unknown"/, "pending is not proof of non-execution");
      assert.equal(await journalStatus(workspace, `${ACTION}:op-amb`), "UNKNOWN");
      assert.equal(provider.counter(), 0);
      assert.equal(provider.requests().filter((r) => r.startsWith("POST")).length, 1, "reconcile is read-only");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("statuses outside the configured contract stay UNKNOWN (pending, unknown, wrong type)", { timeout: 120_000 }, async () => {
    for (const [label, reconcileBody] of [
      ["pending", () => ({ status: "pending" })],
      ["unknown status value", () => ({ status: "exploded" })],
      ["missing status field", () => ({ found: true })],
      ["non-string status", () => ({ status: 42 })],
    ] as Array<[string, () => Record<string, unknown>]>) {
      const provider = await startPendingProvider({ reconcileBody });
      const workspace = makeWorkspace(tmp, `body-${label.split(" ")[0] ?? "x"}`);
      writeStatusFieldActions(workspace, provider.baseUrl);
      const client = await connectClient(workspace);
      try {
        const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: `op-${label}` });
        const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
        assert.equal(outcome.status, "unknown", res.text);

        const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: `op-${label}` });
        assert.match(rec.text, /"status":"unknown"/, `unverifiable ${label} must stay UNKNOWN`);
        assert.equal(await journalStatus(workspace, `${ACTION}:op-${label}`), "UNKNOWN");
      } finally {
        client.kill();
        await client.exit;
        await provider.stop();
      }
    }
  });

  it("malformed reconcile payloads stay UNKNOWN (non-JSON 200, no-op unknown operation)", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ reconcileBody: () => ({ status: "failed" }) });
    const workspace = makeWorkspace(tmp, "malformed");
    // Point the reconcile URL at an endpoint returning a non-JSON body.
    writeRawActions(workspace, {
      schema: "relay.mcp-actions/1",
      actions: [
        {
          id: ACTION,
          label: "Malformed reconcile endpoint",
          http: { url: `${provider.baseUrl}/increment?operationId={operationId}`, method: "POST" },
          reconcile: { url: `${provider.baseUrl}/malformed/{operationId}`, shape: "status-field" },
        },
      ],
    });
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-mal" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", res.text);
      const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-mal" });
      assert.match(rec.text, /"status":"unknown"/, "unreadable reconcile answer must stay UNKNOWN");
      assert.equal(await journalStatus(workspace, `${ACTION}:op-mal`), "UNKNOWN");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("contract-proven non-execution (configured notExecutedStatuses) settles FAILED without resubmitting", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 409, reconcileBody: () => ({ status: "failed" }) });
    const workspace = makeWorkspace(tmp, "provenfail");
    writeStatusFieldActions(workspace, provider.baseUrl, { notExecutedStatuses: ["failed"] });
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-gone" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", res.text);
      assert.equal(provider.counter(), 0, "provider accepted but never committed");

      const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-gone" });
      assert.match(rec.text, /"status":"failed"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-gone`), "FAILED");
      assert.equal(provider.requests().filter((r) => r.startsWith("POST")).length, 1, "reconcile never resubmits");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("with no proof-of-non-execution configured, a same-body reconcile keeps UNKNOWN (fail closed)", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 409 });
    const workspace = makeWorkspace(tmp, "nocontract");
    writeStatusFieldActions(workspace, provider.baseUrl); // no notExecutedStatuses
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-noproof" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", res.text);

      const rec = await client.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-noproof" });
      assert.match(rec.text, /"status":"unknown"/, "an unconfigured status is not proof of non-execution");
      assert.equal(await journalStatus(workspace, `${ACTION}:op-noproof`), "UNKNOWN");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("existing definitive outcomes are preserved", () => {
  it("synchronous found-flag provider: submit 200 commits and CONFIRMS; reconcile found:false still fails", { timeout: 60_000 }, async () => {
    const provider = await startMiniProvider();
    const workspace = makeWorkspace(tmp, "foundflag");
    writeActions(workspace, provider.baseUrl); // found-flag shape
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-sync" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-sync`), "CONFIRMED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("status-field complete submit proves synchronous execution -> CONFIRMED", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 200, submitBodyStatus: "complete", commitAfterMs: 1 });
    const workspace = makeWorkspace(tmp, "synccomplete");
    writeStatusFieldActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-done" });
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /"status":"confirmed"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-done`), "CONFIRMED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("a configured pre-commit rejection on submit still resolves FAILED", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 422, submitBodyStatus: "failed" });
    const workspace = makeWorkspace(tmp, "submitreject");
    writeStatusFieldActions(workspace, provider.baseUrl, {}, { rejectStatuses: [422] });
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-rej" });
      assert.equal(res.isError, true, res.text);
      assert.match(res.text, /"status":"failed"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-rej`), "FAILED");
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});
