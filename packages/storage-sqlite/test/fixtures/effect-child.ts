/**
 * M1 crash-matrix child process fixture.
 *
 * Usage: node effect-child.js <dbPath> <baseUrl> <crashPoint|none> <key>
 *
 * Runs the real `runEffect` state machine against a real SQLite journal,
 * executing against the local HTTP counter provider. `crashPoint` injects
 * death at a specific boundary; runner-level points SIGKILL the process
 * through the runner's crash seam, in-flight points SIGKILL from inside
 * `execute` after observing provider-side markers (inflight receipt /
 * committed effect) while the response is still pending.
 *
 * Prints one JSON line with the EffectOutcome (when it survives) and exits 0.
 */
import { runEffect, type CrashPoint, type ReconcileOutcome, type RunEffectInput } from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined) {
    process.stderr.write("usage: effect-child.js <dbPath> <baseUrl> <crashPoint|none> <key>\n");
    process.exit(64);
  }
  return value;
}

const argv = process.argv.slice(2, 6);
const dbPath = requireArg(argv[0], "dbPath");
const baseUrl = requireArg(argv[1], "baseUrl");
const crashPointArg = requireArg(argv[2], "crashPoint");
const key = requireArg(argv[3], "key");
const crashPoint: CrashPoint | undefined =
  crashPointArg === "none" ? undefined : (crashPointArg as CrashPoint);

function die(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: SIGKILL");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`);
  return (await res.json()) as Record<string, unknown>;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}

async function execute(): Promise<{ remoteRef: string; value: number }> {
  const url = new URL("/increment", baseUrl);
  url.searchParams.set("key", key);
  if (crashPoint === "after-send") {
    url.searchParams.set("ackMs", "400");
    void fetch(url, { method: "POST" }); // request leaves the client
    // Deterministically wait until the provider has received the request.
    await waitFor(
      async () => (await getJson(`/inflight?key=${encodeURIComponent(key)}`)).waiting === true,
      5_000,
    );
    die();
  }
  if (crashPoint === "after-remote-commit") {
    url.searchParams.set("holdMs", "8000");
    void fetch(url, { method: "POST" });
    // Deterministically wait until the remote counter has committed our effect.
    await waitFor(
      async () => (await getJson(`/effects/${encodeURIComponent(key)}`)).found === true,
      5_000,
    );
    die();
  }
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`provider HTTP ${String(res.status)}`);
  const body = (await res.json()) as { remoteRef: string; value: number };
  return body;
}

async function reconcile(): Promise<ReconcileOutcome> {
  const found = await waitFor(
    async () => (await getJson(`/effects/${encodeURIComponent(key)}`)).found === true,
    3_000,
  );
  if (!found) return { found: false };
  const body = (await getJson(`/effects/${encodeURIComponent(key)}`)) as {
    remoteRef?: string;
    value?: number;
  };
  return { found: true, remoteRef: body.remoteRef, result: { value: body.value } };
}

const journal = await SqliteEffectJournal.open({ path: dbPath });
try {
  const input: RunEffectInput = {
    key,
    kind: "http-counter/increment",
    request: { key },
    replay: "never",
    journal,
    execute,
    reconcile,
  };
  const runnerCrashPoint =
    crashPoint === undefined || crashPoint === "after-send" || crashPoint === "after-remote-commit"
      ? undefined
      : crashPoint;
  if (runnerCrashPoint !== undefined) {
    input.crash = { point: runnerCrashPoint, kill: die };
  }
  const outcome = await runEffect(input);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
} finally {
  journal.close();
}
