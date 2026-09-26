/**
 * One-off Pi -> Relay MCP linkage probe (evidence only; NOT product code).
 *
 * Question: can a real, isolated Pi tool invocation of Relay's MCP action be
 * linked to an actually committed Relay effect event by exact non-secret
 * `actionId` / `operationId`, using Pi's public session/tool APIs?
 *
 * Everything here is disposable and loopback-only:
 *   - fake HTTP provider on 127.0.0.1 (the "external effect"),
 *   - a fake local deterministic Pi provider/model (no model service),
 *   - the REAL, unmodified Relay MCP server (packages/mcp/dist/src/main.js),
 *   - a temporary workspace, journal and Pi session directory,
 *   - a minimal MCP bridge registered through Pi's public custom-tool API.
 *
 * Usage:
 *   node reports/pi-relay-link-probe-2026-09-26/probe/probe.mjs <outDir>
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolvePath(HERE, "..", "..", "..");
const PI_DIST = join(REPO, "packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const PI_AI_DIST = join(REPO, "packages/adapter-pi/node_modules/@earendil-works/pi-ai/dist/index.js");
const TYPEBOX = join(REPO, "node_modules/.pnpm/typebox@1.3.27/node_modules/typebox/build/index.mjs");
const RELAY_MCP_MAIN = join(REPO, "packages/mcp/dist/src/main.js");
const RELAY_CLI_MAIN = join(REPO, "packages/cli/dist/src/cli.js");

const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "relay-link-probe-"));
mkdirSync(outDir, { recursive: true });

const pi = await import(pathToFileURL(PI_DIST).href);
const piAi = await import(pathToFileURL(PI_AI_DIST).href);
const { Type } = await import(pathToFileURL(TYPEBOX).href);

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---------------------------------------------------------------- provider --
/** Loopback "external provider": commits a counter, supports found-flag reconcile. */
async function startProvider() {
  let counter = 0;
  const effects = new Set();
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://loopback");
    requests.push(`${req.method} ${url.pathname}`);
    const opId = url.searchParams.get("operationId") ?? "";
    if (req.method === "POST" && url.pathname === "/increment") {
      counter += 1;
      effects.add(opId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: counter }));
      return;
    }
    // Commit-then-error: the classic ambiguous provider answer.
    if (req.method === "POST" && url.pathname === "/increment-ambiguous") {
      counter += 1;
      effects.add(opId);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "committed but answering 503" }));
      return;
    }
    const m = url.pathname.match(/^\/effects\/(.+)$/);
    if (req.method === "GET" && m) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ found: effects.has(decodeURIComponent(m[1])) }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ counter, effects: [...effects] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counter: () => counter,
    effects: () => [...effects],
    requests: () => [...requests],
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

// -------------------------------------------------------------- mcp client --
/** Minimal stdio JSON-RPC client for the real relay-mcp server. */
async function connectRelayMcp(workspace) {
  const child = spawn(process.execPath, [RELAY_MCP_MAIN, "--workspace", workspace], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    const msg = JSON.parse(line);
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = await rpc("initialize", {});
  const tools = await rpc("tools/list", {});
  return {
    initialize: init.result,
    tools: tools.result.tools,
    call: (name, args) => rpc("tools/call", { name, arguments: args }),
    stop: async () => {
      child.stdin.end();
      await new Promise((r) => child.on("close", r));
    },
  };
}

/** JSON-schema (MCP) -> typebox, limited to the string/object shapes relay uses. */
function typeboxFor(inputSchema) {
  const props = {};
  for (const [name, spec] of Object.entries(inputSchema.properties ?? {})) {
    const required = (inputSchema.required ?? []).includes(name);
    const base = Type.String({ description: spec.description ?? "" });
    props[name] = required ? base : Type.Optional(base);
  }
  return Type.Object(props);
}

// ------------------------------------------------------------- fake model ---
const FAKE_PROVIDER_ID = "relay-probe-fake";
const FAKE_MODEL_ID = "relay-probe-deterministic";
const FAKE_API = "relay-probe-api";

function fakeModel() {
  return {
    id: FAKE_MODEL_ID,
    name: "Relay probe deterministic fake",
    api: FAKE_API,
    provider: FAKE_PROVIDER_ID,
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

const ZERO_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Deterministic fake provider: emits a scripted tool call on the first turn
 * (with the preselected non-secret actionId/operationId), then stops. No
 * network, no model service; the tool-call id is generated locally.
 */
function createFakeProvider(plan, observed) {
  const model = fakeModel();
  const message = (content, stopReason) => ({
    role: "assistant",
    content,
    api: FAKE_API,
    provider: FAKE_PROVIDER_ID,
    model: FAKE_MODEL_ID,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  });
  let turn = 0;
  const streamFrom = (context) => {
    const events = piAi.createAssistantMessageEventStream();
    // Record the tool declarations Pi actually sent to the "model".
    for (const m of context.messages) {
      if (m.role === "system" && Array.isArray(m.toolsAdded)) {
        observed.toolsDeclared.push(...m.toolsAdded.map((t) => t.name));
      }
    }
    const step = plan[Math.min(turn, plan.length - 1)];
    turn += 1;
    let msg;
    if (step.kind === "toolCall") {
      msg = message(
        [{ type: "toolCall", id: step.toolCallId, name: step.name, arguments: step.arguments }],
        "toolUse",
      );
    } else {
      msg = message([{ type: "text", text: step.text }], "stop");
    }
    events.push({ type: "start", partial: msg });
    events.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg });
    return events;
  };
  return {
    id: FAKE_PROVIDER_ID,
    name: "Relay probe fake provider",
    auth: {
      apiKey: {
        name: "relay probe (ambient, no credential)",
        resolve: async () => ({ auth: { apiKey: "relay-probe-not-a-secret" }, source: "probe" }),
      },
    },
    getModels: () => [model],
    stream: (_m, context) => streamFrom(context),
    streamSimple: (_m, context) => streamFrom(context),
  };
}

// ------------------------------------------------------------------ journal --
function readJournal(workspace) {
  const db = new DatabaseSync(join(workspace, ".relay", "storage.db"), { readOnly: true });
  const tables = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
    .map((r) => r.name);
  // Sanitized: free-form provider-controlled columns (reason, result_json,
  // remote_ref) are reduced to presence flags, never copied into evidence.
  const effects = db
    .prepare(
      "select id, key, kind, request_hash, intent_json, replay, status, created_at, submitted_at, settled_at, updated_at," +
        " (reason is not null) as has_reason, (result_json is not null) as has_result_json, (remote_ref is not null) as has_remote_ref" +
        " from relay_effects order by key",
    )
    .all();
  const events = tables.includes("relay_effect_events")
    ? db.prepare("select seq, effect_id, key, kind, from_status, to_status, cause, at from relay_effect_events order by seq").all()
    : [];
  const eventColumns = db.prepare("PRAGMA table_info(relay_effect_events)").all().map((c) => c.name);
  const effectColumns = db.prepare("PRAGMA table_info(relay_effects)").all().map((c) => c.name);
  db.close();
  return { tables, effectColumns, eventColumns, effects, events };
}

function relayCliHistory(workspace) {
  const out = spawnSync(process.execPath, [RELAY_CLI_MAIN, "effects", "--history"], {
    cwd: workspace,
    encoding: "utf8",
  });
  return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

function readSessionEntries(sessionFile) {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ------------------------------------------------------------------ scenario -
async function runScenario({ name, ops, provider, workspaceRoot }) {
  const workspace = mkdtempSync(join(workspaceRoot, `${name}-ws-`));
  const sessionDir = mkdtempSync(join(workspaceRoot, `${name}-sessions-`));
  mkdirSync(join(workspace, ".relay"), { recursive: true });
  const actionsDoc = {
    schema: "relay.mcp-actions/1",
    actions: [
      {
        id: "counter-increment",
        label: "Increment the loopback demo counter (non-replayable)",
        http: { url: `${provider.baseUrl}/increment?operationId={operationId}`, method: "POST", timeoutMs: 5000 },
        reconcile: { url: `${provider.baseUrl}/effects/{operationId}`, shape: "found-flag" },
      },
      {
        id: "counter-increment-ambiguous",
        label: "Increment the loopback counter, provider answers 503 after commit",
        http: { url: `${provider.baseUrl}/increment-ambiguous?operationId={operationId}`, method: "POST", timeoutMs: 5000 },
        reconcile: { url: `${provider.baseUrl}/effects/{operationId}`, shape: "found-flag" },
      },
    ],
  };
  const actionsPath = join(workspace, ".relay", "mcp-actions.json");
  writeFileSync(actionsPath, `${JSON.stringify(actionsDoc, null, 2)}\n`);

  const mcp = await connectRelayMcp(workspace);

  // Public Pi custom-tool API: one bridge tool per relay MCP tool. The bridge
  // forwards the model's arguments verbatim; it never injects ids.
  const bridgeCalls = [];
  const customTools = mcp.tools.map((t) =>
    pi.defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: typeboxFor(t.inputSchema),
      execute: async (toolCallId, params) => {
        const response = await mcp.call(t.name, params);
        const result = response.result ?? { content: [{ type: "text", text: JSON.stringify(response.error) }], isError: true };
        bridgeCalls.push({ toolCallId, tool: t.name, arguments: params, isError: result.isError === true });
        return { content: result.content, details: { relayMcpIsError: result.isError === true } };
      },
    }),
  );

  const requested = ops.map((op) => ({ ...op, toolCallId: `probe-call-${randomUUID()}` }));
  const observed = { toolsDeclared: [] };
  const plan = [
    ...requested.map((op) => ({
      kind: "toolCall",
      toolCallId: op.toolCallId,
      name: "relay_submit_action",
      arguments: { actionId: op.actionId, operationId: op.operationId, intent: op.intent },
    })),
    { kind: "text", text: "probe finished" },
  ];
  const fakeProvider = createFakeProvider(plan, observed);

  const modelRuntime = await pi.ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(fakeProvider);
  const sessionManager = pi.SessionManager.create(workspace, sessionDir);
  const { session } = await pi.createAgentSession({
    cwd: workspace,
    model: fakeModel(),
    modelRuntime,
    sessionManager,
    noTools: "builtin",
    customTools,
  });
  await session.prompt("Run the relay actions in the probe plan.");
  const sessionId = session.sessionId;
  session.dispose();
  await mcp.stop();

  const sessionFile =
    session.sessionFile ??
    join(sessionDir, readdirSync(sessionDir).find((f) => f.endsWith(".jsonl")));
  const entries = readSessionEntries(sessionFile);
  const journal = readJournal(workspace);

  return {
    scenario: name,
    requested,
    mcpServerInfo: mcp.initialize.serverInfo,
    mcpToolsOffered: mcp.tools.map((t) => t.name),
    toolsDeclaredToModel: [...new Set(observed.toolsDeclared)],
    bridgeCalls,
    piSessionId: sessionId,
    piSessionFile: sessionFile,
    piSessionSha256: sha256File(sessionFile),
    actionsFileSha256: sha256File(actionsPath),
    journalSha256: sha256File(join(workspace, ".relay", "storage.db")),
    sessionEntries: entries.map((e) => ({
      id: e.id,
      parentId: e.parentId,
      type: e.type,
      role: e.message?.role,
      toolCalls:
        e.message?.role === "assistant"
          ? (e.message.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
          : undefined,
      toolResult:
        e.message?.role === "toolResult"
          ? {
              toolCallId: e.message.toolCallId,
              toolName: e.message.toolName,
              isError: e.message.isError,
              text: (e.message.content ?? []).map((c) => c.text).join("\n"),
            }
          : undefined,
    })),
    journal,
    relayCliHistory: relayCliHistory(workspace),
    workspace,
    sessionDir,
  };
}

// ---------------------------------------------------------------------- main -
const provider = await startProvider();
const workspaceRoot = mkdtempSync(join(tmpdir(), "relay-link-probe-root-"));
const results = [];
const opSuffix = randomUUID().slice(0, 8);

results.push(
  await runScenario({
    name: "success",
    ops: [
      {
        actionId: "counter-increment",
        operationId: `probe-success-${opSuffix}`,
        intent: "probe: increment loopback counter once",
      },
    ],
    provider,
    workspaceRoot,
  }),
);
const counterAfterSuccess = provider.counter();

results.push(
  await runScenario({
    name: "ambiguous",
    ops: [
      {
        actionId: "counter-increment-ambiguous",
        operationId: `probe-ambiguous-${opSuffix}`,
        intent: "probe: provider commits then answers 503",
      },
    ],
    provider,
    workspaceRoot,
  }),
);

// Discrimination control: two tool calls, one session, one workspace, the
// same millisecond-scale window. Only the argument values can tell the two
// committed effects apart — time and directory cannot.
results.push(
  await runScenario({
    name: "two-calls",
    ops: [
      { actionId: "counter-increment", operationId: `probe-alpha-${opSuffix}`, intent: "probe: first of two" },
      { actionId: "counter-increment", operationId: `probe-beta-${opSuffix}`, intent: "probe: second of two" },
    ],
    provider,
    workspaceRoot,
  }),
);

/** Exact-value checks: no timestamps, paths, or ordering are used. */
function linkChecks(scenario) {
  const calls = scenario.sessionEntries.flatMap((e) => e.toolCalls ?? []);
  const toolResults = scenario.sessionEntries.filter((e) => e.toolResult).map((e) => e.toolResult);
  return scenario.requested.map((op) => {
    const call = calls.find((c) => c.id === op.toolCallId);
    const expectedKey = `${op.actionId}:${op.operationId}`;
    const result = toolResults.find((r) => r.toolCallId === op.toolCallId);
    const row = scenario.journal.effects.find((r) => r.key === expectedKey);
    const events = scenario.journal.events.filter((e) => e.key === expectedKey);
    return {
      toolCallId: op.toolCallId,
      expectedKey,
      sessionToolCallArgumentsMatch:
        call !== undefined && call.arguments.actionId === op.actionId && call.arguments.operationId === op.operationId,
      toolResultTextContainsKey: result !== undefined && result.text.includes(`"key":"${expectedKey}"`),
      journalRowExistsForKey: row !== undefined,
      journalRowStatus: row?.status ?? null,
      journalRowKind: row?.kind ?? null,
      journalEventsForKey: events.map((e) => `${e.from_status ?? "-"}->${e.to_status}(${e.cause})`),
      eventEffectIdsMatchRow: row !== undefined && events.every((e) => e.effect_id === row.id),
      otherKeysInJournal: scenario.journal.effects.map((r) => r.key).filter((k) => k !== expectedKey),
    };
  });
}
for (const scenario of results) scenario.linkChecks = linkChecks(scenario);

const evidence = {
  probe: "pi-relay-link-probe",
  generatedAt: new Date().toISOString(),
  versions: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    pi: pi.VERSION,
    relaySourceSha: process.env.RELAY_SOURCE_SHA ?? null,
  },
  loopbackProvider: {
    baseUrl: provider.baseUrl,
    counterAfterSuccessScenario: counterAfterSuccess,
    counterFinal: provider.counter(),
    committedOperationIds: provider.effects(),
    requests: provider.requests(),
  },
  scenarios: results,
};

const evidencePath = join(outDir, "evidence.json");
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
await provider.stop();
process.stdout.write(`${evidencePath}\n`);
process.exit(0);
