/** Synthetic transport only. No request reaches GitHub. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { hashRequest, type EffectStatus } from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { createProbePlan, runProbe, type ProbePlan } from "../examples/github-probe.js";
import { releaseWorkspaceOwnership, takeWorkspaceOwnership } from "../src/lock.js";

const root = mkdtempSync(join(tmpdir(), "relay-probe-"));
after(() => rmSync(root, { recursive: true, force: true }));
const token = "authentication-sentinel-never-persist";
async function plan() {
  return createProbePlan({ repository: "fixture/repo", repositoryId: 17, workspace: mkdtempSync(join(root, "workspace-")) });
}
function mock(p: ProbePlan) {
  const state = { exists: false, drop: false, mismatch: false, identity: true, queryStatus: 200 };
  const calls: { url: string; options: RequestInit }[] = [];
  async function transport(url: string, options: RequestInit): Promise<Response> {
    calls.push({ url, options });
    if (options.method === "POST") {
      state.exists = true;
      if (state.drop) throw new Error(token);
      return new Response("{}", { status: 201 });
    }
    if (url.endsWith("/repos/fixture/repo")) {
      return Response.json({ id: state.identity ? 17 : 18, full_name: "fixture/repo" });
    }
    if (url.includes("?per_page=")) {
      return Response.json({ total_count: state.exists ? 1 : 0, variables: state.exists ? [{ name: p.name }] : [] });
    }
    return Response.json({ name: p.name, value: state.mismatch ? "wrong" : p.value }, { status: state.exists ? state.queryStatus : 404 });
  }
  return { state, calls, transport, posts: () => calls.filter((c) => c.options.method === "POST").length };
}
async function seed(p: ProbePlan, status: EffectStatus) {
  const journal = await SqliteEffectJournal.open({ path: join(p.workspace, "journal.db") });
  try {
    const id = randomUUID();
    await journal.insertPrepared({ id, key: p.key, kind: p.kind, requestHash: p.requestHash, replay: "never", status: "PREPARED", remoteRef: undefined, resultJson: undefined, reason: undefined, createdAt: 1, submittedAt: undefined, settledAt: undefined, updatedAt: 1 });
    if (status !== "PREPARED") await journal.markSubmitted(id, 2);
    if (status === "UNKNOWN") await journal.markUnknown(id, "fixture", 3);
    if (status === "FAILED") await journal.markFailed(id, "fixture", 3);
    if (status === "CONFIRMED") await journal.markConfirmed(id, { remoteRef: undefined, resultJson: "{}", at: 3 });
  } finally { journal.close(); }
}
async function status(p: ProbePlan) {
  const journal = await SqliteEffectJournal.open({ path: join(p.workspace, "journal.db") });
  try { return (await journal.getByKey(p.key))?.status; } finally { journal.close(); }
}

it("requires an exact reviewed plan hash and token before any request", async () => {
  const p = await plan();
  const m = mock(p);
  assert.equal((await runProbe(p, { mode: "execute", token, transport: m.transport })).reason, "approval_required");
  assert.equal((await runProbe(p, { mode: "execute", approvedPlanHash: hashRequest(p), transport: m.transport })).reason, "token_missing");
  assert.equal((await runProbe({ ...p, token }, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport })).reason, "invalid_plan");
  assert.equal((await runProbe({ ...p, value: "changed" }, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport })).reason, "invalid_plan");
  assert.equal(m.calls.length, 0);
});

it("submits once, confirms by exact query, refuses execute re-entry and caches terminal reconciliation", async () => {
  const p = await plan();
  const m = mock(p);
  const options = { mode: "execute" as const, token, approvedPlanHash: hashRequest(p), transport: m.transport };
  const first = await runProbe(p, options);
  assert.equal(first.status, "confirmed");
  assert.equal(first.postAttempts, 1);
  assert.equal(await status(p), "CONFIRMED");
  const count = m.calls.length;
  assert.equal((await runProbe(p, options)).reason, "existing_record");
  assert.equal((await runProbe(p, { mode: "reconcile", transport: m.transport })).status, "confirmed");
  assert.equal(m.calls.length, count);
  assert.equal(m.posts(), 1);
  for (const call of m.calls) {
    assert.ok(call.url.startsWith("https://api.github.com/repos/fixture/repo"));
    assert.equal(call.options.redirect, "error");
    assert.equal((call.options.headers as Record<string, string>).authorization, `Bearer ${token}`);
  }
  assert.deepEqual(JSON.parse(String(m.calls.find((c) => c.options.method === "POST")?.options.body)), { name: p.name, value: p.value });
});

it("lost acknowledgement remains UNKNOWN until exact read-only evidence, without persisting secrets", async () => {
  const p = await plan();
  const m = mock(p);
  m.state.drop = true;
  assert.equal((await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport })).status, "unknown");
  for (const queryStatus of [404, 401, 503]) {
    m.state.queryStatus = queryStatus;
    assert.equal((await runProbe(p, { mode: "reconcile", token, transport: m.transport })).status, "unknown");
  }
  m.state.queryStatus = 200;
  m.state.mismatch = true;
  assert.equal((await runProbe(p, { mode: "reconcile", token, transport: m.transport })).status, "unknown");
  m.state.mismatch = false;
  assert.equal((await runProbe(p, { mode: "reconcile", token, transport: m.transport })).status, "confirmed");
  assert.equal(m.posts(), 1);
  for (const file of readdirSync(p.workspace).filter((name) => name.startsWith("journal.db"))) {
    assert.equal(readFileSync(join(p.workspace, file)).includes(Buffer.from(token)), false);
  }
});

it("refuses all existing records on execute; reconcile never submits PREPARED or creates a missing record", async () => {
  for (const initial of ["PREPARED", "SUBMITTED", "UNKNOWN", "CONFIRMED", "FAILED"] as const) {
    const p = await plan();
    await seed(p, initial);
    const m = mock(p);
    assert.equal((await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport })).reason, "existing_record");
    const observed = await runProbe(p, { mode: "reconcile", token, transport: m.transport });
    assert.equal(observed.status, initial === "PREPARED" ? "prepared_not_submitted" : ["SUBMITTED", "UNKNOWN"].includes(initial) ? "unknown" : initial.toLowerCase());
    assert.equal(m.posts(), 0);
    if (initial === "PREPARED") { assert.equal(await status(p), initial); assert.equal(m.calls.length, 0); }
  }
  const p = await plan();
  const m = mock(p);
  assert.equal((await runProbe(p, { mode: "reconcile", token, transport: m.transport })).reason, "record_missing");
  assert.equal(await status(p), undefined);
  assert.equal(m.calls.length, 0);
});

it("blocks collisions and repository mismatch before submission", async () => {
  for (const collision of [true, false]) {
    const p = await plan();
    const m = mock(p);
    m.state.exists = collision;
    m.state.identity = collision;
    const result = await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport });
    assert.equal(result.reason, "preflight_blocked");
    assert.equal(m.posts(), 0);
    assert.equal(await status(p), undefined);
  }
});

it("rejects a journal hash mismatch and records a proven pre-POST failure separately", async () => {
  const p = await plan();
  await seed({ ...p, requestHash: "f".repeat(64) }, "UNKNOWN");
  const m = mock(p);
  assert.equal((await runProbe(p, { mode: "reconcile", token, transport: m.transport })).reason, "record_mismatch");
  assert.equal(m.calls.length, 0);
  const next = await plan();
  const n = mock(next);
  let identityReads = 0;
  const result = await runProbe(next, { mode: "execute", token, approvedPlanHash: hashRequest(next), transport: async (url, options) => {
    if (url.endsWith("/repos/fixture/repo") && ++identityReads === 2) n.state.identity = false;
    return n.transport(url, options);
  } });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "failed_before_post");
  assert.equal(n.posts(), 0);
  assert.equal(await status(next), "FAILED");
});

it("rejects overlapping calls in the same process before the lock's reentrant branch", async () => {
  const p = await plan();
  const m = mock(p);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const first = runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: async (url, options) => { entered(); await gate; return m.transport(url, options); } });
  await entry;
  const otherComponent = await takeWorkspaceOwnership(p.workspace);
  const second = await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport });
  release();
  assert.equal(otherComponent.kind, "held-elsewhere");
  assert.equal(second.reason, "workspace_busy");
  assert.equal((await first).status, "confirmed");
  assert.equal(m.posts(), 1);
});

it("uses the reviewed scalar copy if a caller changes its plan during awaited transport", async () => {
  const p = await plan();
  const original = structuredClone(p);
  const m = mock(original);
  const result = await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: async (url, options) => {
    p.name = "RELAY_PROBE_" + "A".repeat(32);
    p.workspace = join(root, "changed");
    return m.transport(url, options);
  } });
  assert.equal(result.status, "confirmed");
  assert.equal(await status(original), "CONFIRMED");
  assert.deepEqual(JSON.parse(String(m.calls.find((c) => c.options.method === "POST")?.options.body)), { name: original.name, value: original.value });
});

it("never borrows or releases another component's same-process ownership", async () => {
  const p = await plan();
  const m = mock(p);
  assert.equal((await takeWorkspaceOwnership(p.workspace)).kind, "acquired");
  const before = readFileSync(join(p.workspace, "mcp-owner.lock"), "utf8");
  try {
    assert.equal((await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: m.transport })).reason, "workspace_locked");
    assert.equal(m.calls.length, 0);
    assert.equal(readFileSync(join(p.workspace, "mcp-owner.lock"), "utf8"), before);
  } finally { await releaseWorkspaceOwnership(p.workspace); }
});

it("reports release failure as an internal error without losing confirmed journal evidence", async () => {
  const p = await plan();
  const m = mock(p);
  const lock = join(p.workspace, "mcp-owner.lock");
  let original: string | undefined;
  try {
    const result = await runProbe(p, { mode: "execute", token, approvedPlanHash: hashRequest(p), transport: async (url, options) => {
      if (url.endsWith(`/variables/${p.name}`)) {
        original = readFileSync(lock, "utf8");
        rmSync(lock);
        mkdirSync(lock); // Deterministic release read failure on Windows and Linux.
      }
      return m.transport(url, options);
    } });
    assert.equal(result.status, "error");
    assert.equal(result.reason, "lock_release_failed_inspect_journal");
    assert.equal(result.postAttempts, 1);
    assert.equal(await status(p), "CONFIRMED");
  } finally {
    if (original !== undefined) { rmdirSync(lock); writeFileSync(lock, original); }
    await releaseWorkspaceOwnership(p.workspace);
  }
});

it("holds ownership through a separate-process contender and submits only once", async () => {
  const p = await plan();
  const module = new URL("../examples/github-probe.js", import.meta.url).href;
  const counter = join(p.workspace, "synthetic-posts.txt");
  function start(hold: boolean) {
    const source = `
      import { runProbe } from ${JSON.stringify(module)};
      import { once } from 'node:events';
      import { appendFileSync, existsSync } from 'node:fs';
      const plan = ${JSON.stringify(p)};
      let held = false;
      const result = await runProbe(plan, { mode: 'execute', token: 'synthetic', approvedPlanHash: ${JSON.stringify(hashRequest(p))}, transport: async (url, options) => {
        if (${hold} && !held) { held = true; const released = once(process, 'message'); process.send('acquired'); await released; }
        if (options.method === 'POST') { appendFileSync(${JSON.stringify(counter)}, 'POST\\n'); return new Response('{}', { status: 201 }); }
        if (url.endsWith('/repos/fixture/repo')) return Response.json({ id: 17, full_name: 'fixture/repo' });
        if (url.includes('?per_page=')) return Response.json({ total_count: 0, variables: [] });
        return Response.json({ name: plan.name, value: plan.value }, { status: existsSync(${JSON.stringify(counter)}) ? 200 : 404 });
      } });
      process.send(result); process.disconnect();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const messages: unknown[] = [];
    child.on("message", (message) => messages.push(message));
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    return { child, messages, exited, timer };
  }
  const owner = start(true);
  let contender: ReturnType<typeof start> | undefined;
  try {
    const [message] = await once(owner.child, "message", { signal: AbortSignal.timeout(10000) });
    assert.equal(message, "acquired");
    contender = start(false);
    const [code] = await contender.exited;
    assert.equal(code, 0);
    assert.equal((contender.messages[0] as { reason: string }).reason, "workspace_locked");
    owner.child.send("release");
    const [ownerCode] = await owner.exited;
    assert.equal(ownerCode, 0);
    assert.equal((owner.messages[1] as { status: string }).status, "confirmed");
    assert.equal(readFileSync(counter, "utf8"), "POST\n");
    assert.equal(await status(p), "CONFIRMED");
  } finally {
    for (const process of [owner, contender]) if (process) {
      clearTimeout(process.timer);
      process.child.kill("SIGKILL");
      await process.exited;
    }
  }
});
