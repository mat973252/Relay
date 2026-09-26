#!/usr/bin/env node
/** Opt-in live-model acceptance. Only synthetic orders reach AISIX.
 * Usage: node examples/business-sandbox.mjs [model-id]
 * Requires the user's existing Pi AISIX configuration; never copies credentials.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { startReportProvider, reportSnapshot, EXPECTED_CSV } from "../packages/mcp/dist/test/fixtures/report-provider.js";
import { connectClient, writeRawActions, journalStatus } from "../packages/mcp/dist/test/helpers.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const piPath = join(repo, "packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const pi = await import(pathToFileURL(piPath).href);
const { Type } = await import(pathToFileURL(createRequire(realpathSync(piPath)).resolve("typebox")).href);
const root = mkdtempSync(join(tmpdir(), "relay-business-model-"));
console.log(`Evidence directory: ${root}`);
const workspace = join(root, "relay");
const business = join(root, "business");
mkdirSync(workspace, { recursive: true });
const actionId = "export-orders";
const operationId = "monthly-orders-202609";
const key = `${actionId}:${operationId}`;
const phases = [];
const modelRuntime = await pi.ModelRuntime.create({
  modelsPath: join(homedir(), ".pi/agent/models.json"),
  authPath: join(root, "isolated-auth.json"), modelsStorePath: join(root, "model-catalog.json"),
  refreshOnCreate: false, allowModelNetwork: false,
});
const model = modelRuntime.getModel("aisix", process.argv[2] ?? "glm-5.3-flash");
assert.ok(model, "requested AISIX model must exist in current Pi configuration");
let provider = await startReportProvider(business, "disconnect");
const port = Number(new URL(provider.baseUrl).port);
writeRawActions(workspace, { schema: "relay.mcp-actions/1", actions: [{
  id: actionId, label: "导出合成订单报表", description: "异步任务。接单不代表完成，查询暂不可见不代表未执行。",
  http: { url: `${provider.baseUrl}/exports/{operationId}`, method: "POST", timeoutMs: 5000, rejectStatuses: [422] },
  reconcile: { url: `${provider.baseUrl}/exports/{operationId}`, shape: "status-field", completeStatuses: ["complete"] },
}] });
let client = await connectClient(workspace);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function exportHistory(path) {
  const result = spawnSync(process.execPath, [join(repo, "packages/cli/dist/src/cli.js"), "effects", "--history", "--json"], { cwd: workspace, encoding: "utf8" });
  assert.equal(result.status, 0, "read-only history export failed");
  writeFileSync(path, result.stdout);
  return path;
}

async function phase(name, prompt) {
  const calls = [];
  const agentDir = join(root, name, "agent");
  mkdirSync(agentDir, { recursive: true });
  const definitions = [
    ["relay_list_unresolved", "列出持久化的未完成操作，恢复前先调用，复用其中的actionId和operationId。", Type.Object({})],
    ["relay_submit_action", "创建报表任务，只能首次提交。UNKNOWN时不得创建新ID重试。", Type.Object({ actionId: Type.String(), operationId: Type.String() })],
    ["relay_reconcile_operation", "只读查询原操作结果。UNKNOWN时保留未知，不提交新任务。", Type.Object({ actionId: Type.String(), operationId: Type.String() })],
  ];
  const customTools = definitions.map(([toolName, description, parameters]) => pi.defineTool({
    name: toolName, label: toolName, description, parameters,
    execute: async (toolCallId, args) => {
      if (calls.length >= 8) throw new Error("sandbox tool-call budget exceeded");
      const result = await client.call(toolName, args);
      calls.push({ toolCallId, tool: toolName, arguments: args, result });
      return { content: [{ type: "text", text: result.text }], details: { isError: result.isError === true } };
    },
  }));
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "你是报表业务助手。只能使用提供的Relay工具。业务ID必须稳定；UNKNOWN不代表失败或完成。按用户要求执行一次操作或查询后停止，不要轮询。",
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await pi.createAgentSession({
    cwd: workspace, agentDir, model, modelRuntime, thinkingLevel: "off", resourceLoader,
    noTools: "builtin", customTools,
    settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    sessionManager: pi.SessionManager.create(workspace, join(root, name, "sessions")),
  });
  const activeTools = session.getActiveToolNames();
  assert.deepEqual([...activeTools].sort(), definitions.map(([name]) => name).sort());
  const timer = setTimeout(() => void session.abort(), 90_000);
  let entry;
  try {
    await session.prompt(prompt);
    const messages = session.messages.filter((message) => message.role === "assistant");
    assert.ok(messages.length > 0 && messages.every((message) => !["error", "aborted"].includes(message.stopReason)), "model request failed or aborted");
    entry = { name, sessionId: session.sessionId, sessionFile: session.sessionFile,
      activeTools, calls, usage: messages.map((message) => message.usage),
      assistantText: messages.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)),
    };
  } finally { clearTimeout(timer); session.dispose(); }
  assert.ok(entry.sessionFile, "Pi must persist the actual session");
  entry.sessionSha256 = sha(entry.sessionFile);
  // Check persisted model-selected arguments, not just bridge bookkeeping.
  const persisted = readFileSync(entry.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  for (const call of calls) {
    const saved = persisted.flatMap((e) => e.message?.role === "assistant" ? e.message.content : [])
      .find((part) => part.type === "toolCall" && part.id === call.toolCallId);
    assert.ok(saved, "tool invocation must exist in the real model session");
    assert.deepEqual(saved.arguments, call.arguments);
  }
  phases.push(entry);
  entry.historyPath = exportHistory(join(root, name, "relay-history.json"));
  console.log(`${name}: ${calls.map((call) => call.tool).join(" -> ")}`);
  return entry;
}

try {
  const submitted = await phase("submit", `请导出2026年9月的合成订单报表。首次操作actionId=${actionId}，operationId=${operationId}。只调用一次提交工具，返回未知时说明未知并停下，不要轮询或重试。`);
  assert.equal(submitted.calls.filter((call) => call.tool === "relay_submit_action").length, 1);
  assert.equal(await journalStatus(workspace, key), "UNKNOWN");
  assert.equal(reportSnapshot(business).jobs.length, 1);
  const firstProviderPid = provider.pid;
  client.kill(); await client.exit; await provider.stop();
  provider = await startReportProvider(business, "accepted", port);
  assert.notEqual(provider.pid, firstProviderPid);
  client = await connectClient(workspace);
  const recovered = await phase("recover", "你是崭新的会话。上一个报表请求提交后断线了。先发现持久化的未完成操作，再用它的原始ID只读查询一次；不能重新提交。若仍未知就说明未知并停下。");
  assert.equal(recovered.calls[0]?.tool, "relay_list_unresolved");
  assert.ok(recovered.calls.some((call) => call.tool === "relay_reconcile_operation" && call.arguments.operationId === operationId));
  assert.ok(recovered.calls.every((call) => call.tool !== "relay_submit_action"));
  assert.equal(await journalStatus(workspace, key), "UNKNOWN");
  await provider.control("visible");
  // Independently verify the actual pending response before completing the worker.
  assert.match((await client.call("relay_reconcile_operation", { actionId, operationId })).text, /"status":"unknown"/);
  await provider.control("release");
  const deadline = Date.now() + 5000;
  while (reportSnapshot(business).jobs[0]?.status !== "complete") {
    assert.ok(Date.now() < deadline, "report worker timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const completed = await phase("confirm", "后台已完成原来的合成订单报表。先发现未完成的持久化操作，再使用原始ID只读核实一次；不要创建新任务。只有工具确认成功才报告完成。");
  assert.ok(completed.calls.every((call) => call.tool !== "relay_submit_action"));
  assert.equal(await journalStatus(workspace, key), "CONFIRMED");
  const businessEvidence = reportSnapshot(business);
  assert.equal(businessEvidence.jobs.length, 1);
  assert.equal(businessEvidence.requests.filter((r) => r.method === "POST").length, 1);
  assert.deepEqual(readdirSync(join(business, "artifacts")), [`${operationId}.csv`]);
  const csv = join(business, "artifacts", `${operationId}.csv`);
  assert.equal(readFileSync(csv, "utf8"), EXPECTED_CSV);
  assert.equal(sha(csv), businessEvidence.jobs[0].digest);
  const historyPath = exportHistory(join(root, "relay-history.json"));
  const evidence = { scenario: "synthetic-order-export", generatedAt: new Date().toISOString(),
    model: { provider: model.provider, id: model.id }, node: process.version, pi: pi.VERSION,
    phases, business: businessEvidence, artifact: { path: csv, sha256: sha(csv) }, historyPath,
    assertions: { singlePost: true, singleJob: true, correctArtifact: true, recoveredOriginalIdentity: true, terminalOnlyAfterCompletion: true },
  };
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS: ${model.provider}/${model.id}, POST=1, job=1, CSV verified; ${join(root, "evidence.json")}`);
} catch (error) {
  writeFileSync(join(root, "failure.json"), JSON.stringify({ model: model.id, phases, errorKind: error.name }, null, 2));
  throw error;
} finally { client.kill(); await client.exit; await provider.stop(); }
