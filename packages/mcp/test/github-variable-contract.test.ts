/** Local contract only: no GitHub traffic or real credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runLocalVariable, type VariableIntent } from "./fixtures/github-variable-effect.js";
import { SqliteEffectJournal } from "@relay/storage-sqlite";

const root = mkdtempSync(join(tmpdir(), "relay-variable-contract-"));
after(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = "synthetic-auth-must-not-persist";
function assertAuthenticationNotStored(workspace: string) {
  for (const file of readdirSync(workspace).filter((name) => /^journal\.db(?:-(?:wal|shm))?$/.test(name))) {
    assert.equal(readFileSync(join(workspace, file)).includes(Buffer.from(TOKEN)), false, file);
  }
}
async function provider() {
  const state = { posts: 0, requests: [] as string[], repositoryId: 17, queryStatus: 200, dropResponse: false, value: "fixture-value", name: "RELAY_PROBE_FIXTURE", exists: false };
  const server = createServer(async (req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      assert.deepEqual(JSON.parse(body), { name: "RELAY_PROBE_FIXTURE", value: "fixture-value" });
      state.posts++;
      state.exists = true;
      if (state.dropResponse) { req.socket.destroy(); return; }
      res.writeHead(201).end("{}");
    } else if (req.url === "/repos/fixture/repo") {
      res.end(JSON.stringify({ id: state.repositoryId }));
    } else {
      res.writeHead(state.exists ? state.queryStatus : 404);
      res.end(JSON.stringify({ name: state.name, value: state.value }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const intent: VariableIntent = { baseUrl: `http://127.0.0.1:${address.port}`, repository: "fixture/repo", repositoryId: 17, name: "RELAY_PROBE_FIXTURE", value: "fixture-value" };
  return { state, intent, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

it("confirms exact local context once and never persists authentication", async () => {
  const p = await provider();
  const workspace = mkdtempSync(join(root, "basic-"));
  try {
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    assert.equal(p.state.posts, 1);
    assert.deepEqual(p.state.requests, ["GET /repos/fixture/repo", "POST /repos/fixture/repo/actions/variables", "GET /repos/fixture/repo", "GET /repos/fixture/repo/actions/variables/RELAY_PROBE_FIXTURE"]);
    assertAuthenticationNotStored(workspace);
    await assert.rejects(runLocalVariable(workspace, { ...p.intent, value: "different" }, TOKEN), /different effect/);
    await assert.rejects(runLocalVariable(workspace, { ...p.intent, repositoryId: 18 }, TOKEN), /different effect/);
    await assert.rejects(runLocalVariable(workspace, { ...p.intent, baseUrl: "http://127.0.0.1:1" }, TOKEN), /different effect/);
    assert.equal(p.state.posts, 1);
  } finally { await p.close(); }
});

it("lost acknowledgement and nonmatching queries remain UNKNOWN without resubmission", async () => {
  const p = await provider();
  const workspace = mkdtempSync(join(root, "unknown-"));
  try {
    p.state.dropResponse = true;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    assertAuthenticationNotStored(workspace);
    for (const status of [404, 401, 503]) {
      p.state.queryStatus = status;
      assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    }
    p.state.queryStatus = 200;
    p.state.value = "wrong";
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    p.state.value = p.intent.value;
    p.state.name = "WRONG_NAME";
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    p.state.name = p.intent.name;
    p.state.repositoryId = 18;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    p.state.repositoryId = 17;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    p.state.queryStatus = 503;
    const queries = p.state.requests.length;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    assert.equal(p.state.requests.length, queries, "confirmed is terminal and is not downgraded by a later uncertain query");
    assert.equal(p.state.posts, 1);
  } finally { await p.close(); }
});

it("rejects nonloopback origins before a network call", async () => {
  const p = await provider();
  try {
    await assert.rejects(runLocalVariable(mkdtempSync(join(root, "external-")), { ...p.intent, baseUrl: "https://api.github.com" }, TOKEN), /local contract only/);
    assert.equal(p.state.requests.length, 0);
  } finally { await p.close(); }
});

it("an accepted POST without a matching query remains UNKNOWN", async () => {
  const p = await provider();
  const workspace = mkdtempSync(join(root, "post-query-"));
  try {
    p.state.value = "wrong-after-create";
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
    assert.equal(p.state.posts, 1);
    p.state.value = p.intent.value;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    assert.equal(p.state.posts, 1);
  } finally { await p.close(); }
});

for (const initial of ["PREPARED", "UNKNOWN"] as const) {
it(`two processes recover ${initial} with one POST and no terminal downgrade`, { timeout: 30000 }, async () => {
  const p = await provider();
  const workspace = mkdtempSync(join(root, "race-"));
  const input = join(workspace, "fixture.json");
  writeFileSync(input, JSON.stringify(p.intent));
  const childPath = fileURLToPath(new URL("./fixtures/github-variable-child.js", import.meta.url));
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [childPath, workspace, input, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const done = once(child, "close").then(([code]) => ({ code, stdout, stderr })).finally(() => clearTimeout(timer));
    return { child, done };
  };
  const children: ReturnType<typeof launch>[] = [];
  try {
    if (initial === "PREPARED") {
      const seed = launch("crash-prepared");
      children.push(seed);
      const killed = await seed.done;
      assert.notEqual(killed.code, 0);
      assert.equal(p.state.posts, 0);
      const journal = await SqliteEffectJournal.open({ path: join(workspace, "journal.db") });
      try {
        assert.equal((await journal.getByKey("github-variable:fixture-operation"))?.status, "PREPARED");
      } finally { journal.close(); }
    } else {
      p.state.dropResponse = true;
      assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "unknown");
      p.state.dropResponse = false;
    }
    const a = launch("race"); const b = launch("race");
    children.push(a, b);
    const result = await Promise.all([a.done, b.done]);
    assert.ok(result.every((r) => r.code === 0), JSON.stringify(result));
    const statuses = result.map((r) => JSON.parse(r.stdout).status as string);
    assert.equal(statuses.filter((s) => s === "confirmed").length, 1);
    assert.equal(statuses.filter((s) => s === "locked").length, 1);
    assert.equal(p.state.posts, 1);
    p.state.queryStatus = 503;
    const requests = p.state.requests.length;
    assert.equal((await runLocalVariable(workspace, p.intent, TOKEN)).status, "confirmed");
    assert.equal(p.state.requests.length, requests);
    assert.equal(p.state.posts, 1);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((c) => c.done));
    await p.close();
  }
});
}
