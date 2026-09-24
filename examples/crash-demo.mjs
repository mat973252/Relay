#!/usr/bin/env node
/**
 * Relay crash demo — the one-sitting proof.
 *
 * Claim being demonstrated:
 *   an agent process dies AFTER an external HTTP action commits remotely;
 *   the process restarts and replays the SAME semantic operation id;
 *   Relay does not silently submit the action twice. While the outcome was
 *   ambiguous the journal held UNKNOWN, and confirmation came from a
 *   read-only reconciliation, never from a blind retry.
 *
 * Real guarantee (nothing stronger is claimed):
 *   no silent duplicate for actions executed THROUGH Relay when the remote
 *   side commits before the local confirmation lands. Stronger guarantees
 *   need downstream idempotency or a reliable reconciliation query.
 *
 * Requirements: Node 22+, a built workspace (corepack pnpm install &&
 * corepack pnpm typecheck). No Pi, no model account, no cloud, no Docker.
 *
 * Usage:
 *   node examples/crash-demo.mjs            # full orchestrated run + assertions
 *   node examples/crash-demo.mjs crash      # phase 1: die after remote commit
 *   node examples/crash-demo.mjs resume     # phase 2: restart + reconcile
 *   node examples/crash-demo.mjs provider   # standalone counter provider
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = new URL("../packages/core/dist/src/index.js", import.meta.url).href;
const SQLITE = new URL("../packages/storage-sqlite/dist/src/index.js", import.meta.url).href;
const { runEffect, AmbiguousEffectError } = await import(CORE);
const { SqliteEffectJournal } = await import(SQLITE);

const OPERATION_ID = "invoice-import:2026-09-24-batch-017"; // stable across sessions
const HOLD_MS = 4000; // provider commits, then holds the response this long

// ---------------------------------------------------------------------------
// Local HTTP counter provider (the "remote" side). It commits durably and
// only THEN answers, giving us the dangerous window on purpose.
// ---------------------------------------------------------------------------
export async function startProvider() {
  let counter = 0;
  const effects = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://demo");
    if (req.method === "POST" && url.pathname === "/increment") {
      const key = url.searchParams.get("key") ?? "";
      if (effects.has(key)) {
        json(res, 200, { ok: true, deduplicated: true, value: effects.get(key).value });
        return;
      }
      counter += 1; // <-- REMOTE COMMIT happens here, before the response
      effects.set(key, { value: counter, at: Date.now() });
      setTimeout(() => json(res, 200, { ok: true, value: counter }), HOLD_MS);
      return;
    }
    const m = url.pathname.match(/^\/effects\/(.+)$/);
    if (req.method === "GET" && m) {
      const hit = effects.get(decodeURIComponent(m[1] ?? ""));
      json(res, 200, hit === undefined ? { found: false } : { found: true, value: hit.value });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      json(res, 200, { counter });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state: () => ({ counter }),
    stop: () => new Promise((resolve) => server.closeAllConnections?.() ?? server.close(resolve)),
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const getJson = async (url) => (await fetch(url)).json();

// ---------------------------------------------------------------------------
// Effect wiring: execute() against the provider; ambiguity (connection died
// before the response) maps to UNKNOWN, never to a retry.
// ---------------------------------------------------------------------------
function effectInput(journal, baseUrl) {
  return {
    key: `counter-increment:${OPERATION_ID}`,
    kind: "http-counter/increment",
    request: { operationId: OPERATION_ID },
    replay: "never",
    journal,
    execute: async () => {
      try {
        const res = await fetch(
          new URL(`/increment?key=${encodeURIComponent(OPERATION_ID)}`, baseUrl),
          { method: "POST" },
        );
        if (!res.ok) throw new AmbiguousEffectError(`provider HTTP ${res.status}`);
        const body = await res.json();
        return { value: body.value };
      } catch (err) {
        if (err instanceof AmbiguousEffectError) throw err;
        throw new AmbiguousEffectError(`connection lost before response: ${err.message}`);
      }
    },
    reconcile: async () => {
      const body = await getJson(
        new URL(`/effects/${encodeURIComponent(OPERATION_ID)}`, baseUrl),
      ); // READ-ONLY observation before any CONFIRMED
      return body.found
        ? { found: true, remoteRef: OPERATION_ID, result: { value: body.value } }
        : { found: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Phases. "crash" runs in a child process that SIGKILLs itself while the
// provider response is still pending (i.e., after the remote commit).
// ---------------------------------------------------------------------------
async function phaseCrash(dbPath, baseUrl) {
  const journal = await SqliteEffectJournal.open({ path: dbPath });
  const outcome = await runEffect({ ...effectInput(journal, baseUrl) });
  console.log(`[crash] unexpected completion: ${JSON.stringify(outcome)}`);
  process.exit(9);
}

async function phaseResume(dbPath, baseUrl) {
  const journal = await SqliteEffectJournal.open({ path: dbPath });
  const before = (await journal.list()).map((r) => `${r.key}=${r.status}`).join(", ");
  console.log(`[resume] journal before replay: ${before}`);
  const outcome = await runEffect({ ...effectInput(journal, baseUrl) });
  const after = (await journal.list()).map((r) => r.status).join(",");
  console.log(
    `[resume] outcome=${outcome.status} reconciled=${outcome.reconciled ?? false} result=${JSON.stringify(outcome.result ?? null)}`,
  );
  console.log(`[resume] journal after replay: ${after}`);
  const ok = outcome.status === "confirmed" && outcome.reconciled === true;
  process.exit(ok ? 0 : 3);
}

// ---------------------------------------------------------------------------
// Orchestration: provider in THIS process, phases as real child processes,
// async spawn (a blocked event loop would deadlock the in-process provider).
// ---------------------------------------------------------------------------
async function orchestrate() {
  const provider = await startProvider();
  const tmp = mkdtempSync(join(tmpdir(), "relay-demo-"));
  const dbPath = join(tmp, "storage.db");
  const self = fileURLToPath(import.meta.url);
  const log = (s) => console.log(`\n=== ${s} ===`);

  const runPhase = (name) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [self, name, dbPath, provider.baseUrl], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", reject);
      child.on("close", (status, signal) => resolve({ status, signal, out }));
    });

  try {
    log(`remote counter provider at ${provider.baseUrl} (commits BEFORE answering, holds response ${HOLD_MS}ms)`);
    log(`operation id: ${OPERATION_ID}`);

    log("PHASE 1 — submit and die after the remote commit");
    const crashed = await runPhase("crash");
    const sawRemoteCommit = (await getJson(new URL("/state", provider.baseUrl))).counter === 1;
    console.log(
      `[orchestrator] crash phase: signal=${crashed.signal} status=${crashed.status} remoteCommitted=${sawRemoteCommit}`,
    );
    if (crashed.signal !== "SIGKILL" || !sawRemoteCommit) {
      throw new Error("precondition failed: child must die by SIGKILL after the remote commit");
    }

    log("PHASE 2 — restart, replay the SAME operation id");
    const resumed = await runPhase("resume");
    console.log(resumed.out.trim());
    if (resumed.status !== 0) throw new Error("resume phase failed");

    log("ASSERTIONS");
    const counter = (await getJson(new URL("/state", provider.baseUrl))).counter;
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    const records = await journal.list();
    journal.close();
    const record = records.find((r) => r.key === `counter-increment:${OPERATION_ID}`);
    const checks = [
      ["remote counter === 1 (no silent duplicate)", counter === 1],
      ["journal record exists", record !== undefined],
      ["journal status === CONFIRMED", record?.status === "CONFIRMED"],
      ["confirmation came via reconciliation", resumed.out.includes("reconciled=true")],
    ];
    let failed = false;
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      failed ||= !ok;
    }
    log("what actually happened");
    console.log(
      [
        `1. The child submitted the increment; the provider committed it (counter=1) and held the response.`,
        `2. The child was SIGKILLed before any local CONFIRMED could be written.`,
        `3. On restart the same operation id replayed as an ambiguous effect.`,
        `4. Relay did NOT resend the increment; it asked the provider a read-only question.`,
        `5. The provider said "found"; only then did Relay mark the effect CONFIRMED.`,
        `6. Final remote executions of this operation: ${counter}.`,
      ].join("\n      "),
    );
    if (failed) process.exitCode = 1;
  } finally {
    await provider.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const [phase, dbPath, baseUrl] = process.argv.slice(2);
if (phase === "crash" && dbPath && baseUrl) {
  // Race: runEffect waits for the held response while a watcher polls the
  // provider's read-only /effects endpoint. The moment the remote commit is
  // observable, this process dies for real — before any local CONFIRMED.
  const crashWhenCommitted = async () => {
    for (let i = 0; i < 500; i += 1) {
      const body = await getJson(new URL(`/effects/${encodeURIComponent(OPERATION_ID)}`, baseUrl));
      if (body.found === true) {
        console.log(`[crash] remote commit observed; dying before the response arrives`);
        process.kill(process.pid, "SIGKILL");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    console.error("[crash] never observed the remote commit");
    process.exit(8);
  };
  void crashWhenCommitted();
  await phaseCrash(dbPath, baseUrl);
} else if (phase === "resume" && dbPath && baseUrl) {
  await phaseResume(dbPath, baseUrl);
} else if (phase === "provider") {
  const p = await startProvider();
  console.log(p.baseUrl);
  setInterval(() => {}, 10_000);
} else {
  await orchestrate();
}
