import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { connectClient, journalStatus, makeTempRoot, makeWorkspace, writeRawActions } from "./helpers.js";
import { EXPECTED_CSV, reportSnapshot, startReportProvider, type Fault } from "./fixtures/report-provider.js";

const root = makeTempRoot("relay-business-");
after(() => rmSync(root, { recursive: true, force: true }));
const actionId = "export-orders";
function configure(workspace: string, baseUrl: string) {
  writeRawActions(workspace, { schema: "relay.mcp-actions/1", actions: [{
    id: actionId, label: "Export synthetic orders to CSV",
    http: { url: `${baseUrl}/exports/{operationId}`, method: "POST", timeoutMs: 5000, rejectStatuses: [422] },
    reconcile: { url: `${baseUrl}/exports/{operationId}`, shape: "status-field", completeStatuses: ["complete"] },
  }] });
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "business condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const fault of ["accepted", "disconnect", "hold"] as Fault[]) {
  it(`durable report export: ${fault}, double restart, invisible/pending/complete`, { timeout: 40_000 }, async () => {
    const workspace = makeWorkspace(root, fault);
    const business = join(workspace, "business");
    let provider = await startReportProvider(business, fault);
    const port = Number(new URL(provider.baseUrl).port);
    configure(workspace, provider.baseUrl);
    let client = await connectClient(workspace);
    const operationId = "monthly-orders-202609";
    const args = { actionId, operationId };
    try {
      const submitted = client.call("relay_submit_action", args);
      await until(() => reportSnapshot(business).jobs.length === 1);
      if (fault !== "hold") {
        assert.match((await submitted).text, /"status":"unknown"/);
        assert.equal(await journalStatus(workspace, `${actionId}:${operationId}`), "UNKNOWN");
      } else {
        assert.equal(await journalStatus(workspace, `${actionId}:${operationId}`), "SUBMITTED");
      }
      client.kill(); await client.exit;
      await provider.stop();
      provider = await startReportProvider(business, "accepted", port);
      client = await connectClient(workspace);
      const unresolved = await client.call("relay_list_unresolved", {});
      assert.ok(unresolved.text.includes(operationId), "new session discovers original business ID");
      assert.match((await client.call("relay_reconcile_operation", args)).text, /"status":"unknown"/);
      await provider.control("visible");
      assert.match((await client.call("relay_reconcile_operation", args)).text, /"status":"unknown"/);
      // Even an explicit replay with the same identity must only reconcile.
      assert.match((await client.call("relay_submit_action", args)).text, /"status":"unknown"/);
      await provider.control("release");
      await until(() => reportSnapshot(business).jobs[0]?.status === "complete");
      assert.match((await client.call("relay_reconcile_operation", args)).text, /"status":"confirmed"/);
      assert.match((await client.call("relay_submit_action", args)).text, /"status":"confirmed"/);
      const snapshot = reportSnapshot(business);
      assert.equal(snapshot.jobs.length, 1);
      assert.equal(snapshot.requests.filter((r) => r.method === "POST").length, 1);
      assert.deepEqual(readdirSync(join(business, "artifacts")), [`${operationId}.csv`]);
      const csv = readFileSync(join(business, "artifacts", `${operationId}.csv`), "utf8");
      assert.equal(csv, EXPECTED_CSV);
      assert.equal(snapshot.jobs[0]?.digest, createHash("sha256").update(csv).digest("hex"));
    } finally { client.kill(); await client.exit; await provider.stop(); }
  });
}

it("explicit business rejection creates no export or artifact", { timeout: 30_000 }, async () => {
  const workspace = makeWorkspace(root, "reject");
  const business = join(workspace, "business");
  const provider = await startReportProvider(business, "reject");
  configure(workspace, provider.baseUrl);
  const client = await connectClient(workspace);
  try {
    const args = { actionId, operationId: "invalid-period" };
    assert.match((await client.call("relay_submit_action", args)).text, /"status":"failed"/);
    await client.call("relay_reconcile_operation", args);
    assert.equal(reportSnapshot(business).jobs.length, 0);
    assert.equal(reportSnapshot(business).requests.length, 1);
    assert.deepEqual(readdirSync(join(business, "artifacts")), []);
  } finally { client.kill(); await client.exit; await provider.stop(); }
});

it("two intended reports keep distinct durable identities", { timeout: 30_000 }, async () => {
  const workspace = makeWorkspace(root, "two");
  const business = join(workspace, "business");
  const provider = await startReportProvider(business);
  configure(workspace, provider.baseUrl);
  const client = await connectClient(workspace);
  try {
    for (const operationId of ["report-a", "report-b"]) {
      assert.match((await client.call("relay_submit_action", { actionId, operationId })).text, /"status":"unknown"/);
    }
    await provider.control("visible"); await provider.control("release");
    await until(() => reportSnapshot(business).jobs.every((j) => j.status === "complete"));
    for (const operationId of ["report-a", "report-b"]) {
      assert.match((await client.call("relay_reconcile_operation", { actionId, operationId })).text, /"status":"confirmed"/);
    }
    assert.equal(reportSnapshot(business).jobs.length, 2);
    assert.equal(reportSnapshot(business).requests.filter((r) => r.method === "POST").length, 2);
    assert.deepEqual(readdirSync(join(business, "artifacts")).sort(), ["report-a.csv", "report-b.csv"]);
  } finally { client.kill(); await client.exit; await provider.stop(); }
});
