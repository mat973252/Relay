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
import { spawn } from "node:child_process";
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
  MAIN,
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

describe("status contract config validation", () => {
  it("rejects 'pending' (any case) and overlapping lists at config load (exit 78)", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider();
    await provider.stop();
    const badContracts: Array<[string, Record<string, unknown>, RegExp]> = [
      ["pending-as-complete", { completeStatuses: ["pending"] }, /pending/i],
      ["PENDING-as-complete", { completeStatuses: ["PENDING"] }, /pending/i],
      ["pending-as-not-executed", { notExecutedStatuses: ["pending"] }, /pending/i],
      [
        "overlap",
        { completeStatuses: ["complete", "failed"], notExecutedStatuses: ["failed"] },
        /overlap/i,
      ],
      [
        "overlap-via-default-complete",
        { notExecutedStatuses: ["complete"] },
        /overlap/i,
      ],
    ];
    for (const [label, extraReconcile, pattern] of badContracts) {
      const workspace = makeWorkspace(tmp, `bad-${label}`);
      writeStatusFieldActions(workspace, provider.baseUrl, extraReconcile);
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [MAIN, "--workspace", workspace], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (status) => resolve({ status, stderr }));
      });
      assert.equal(result.status, 78, `${label}: expected config refusal, stderr: ${result.stderr}`);
      assert.match(result.stderr, pattern, label);
    }
  });

  it("ordinary defaults and non-overlapping lists still load", { timeout: 60_000 }, async () => {
    const provider = await startPendingProvider();
    const workspace = makeWorkspace(tmp, "goodcontract");
    writeStatusFieldActions(workspace, provider.baseUrl, { notExecutedStatuses: ["failed"] });
    const client = await connectClient(workspace); // initialize succeeds => config loaded
    try {
      const res = await client.call("relay_list_unresolved", {});
      assert.equal(res.isError, false, res.text);
      assert.match(res.text, /no unresolved operations/);
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});

describe("status semantics are bound into request identity", () => {
  it("changed status lists reject reuse of an existing operation id before any remote call", { timeout: 90_000 }, async () => {
    const provider = await startPendingProvider({ submitStatus: 409 });
    const workspace = makeWorkspace(tmp, "fpchange");
    writeStatusFieldActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const res = await client.call("relay_submit_action", { actionId: ACTION, operationId: "op-fp" });
      const outcome = JSON.parse(res.text.split("\n")[0] ?? "") as { status: string };
      assert.equal(outcome.status, "unknown", res.text);
    } finally {
      client.kill();
      await client.exit;
    }

    // Same action id/URL/method but a different status contract: interpreting
    // the remote status differently must not reuse the recorded operation.
    writeStatusFieldActions(workspace, provider.baseUrl, {
      completeStatuses: ["done"],
      notExecutedStatuses: ["failed"],
    });
    const client2 = await connectClient(workspace);
    try {
      const rec = await client2.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-fp" });
      assert.equal(rec.isError, true, "a changed status contract is a different effect");
      assert.match(rec.text, /different effect/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-fp`), "UNKNOWN", "journal untouched");
      assert.equal(
        provider.requests().filter((r) => r.startsWith("GET") && r.includes("op-fp")).length,
        0,
        "identity mismatch must be rejected before any remote reconcile call",
      );
    } finally {
      client2.kill();
      await client2.exit;
    }

    // Restoring the default contract makes the operation recoverable again.
    writeStatusFieldActions(workspace, provider.baseUrl);
    const client3 = await connectClient(workspace);
    try {
      const rec = await client3.call("relay_reconcile_operation", { actionId: ACTION, operationId: "op-fp" });
      assert.equal(rec.isError, false, rec.text);
      assert.match(rec.text, /"status":"unknown"/);
      assert.equal(await journalStatus(workspace, `${ACTION}:op-fp`), "UNKNOWN");
    } finally {
      client3.kill();
      await client3.exit;
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
