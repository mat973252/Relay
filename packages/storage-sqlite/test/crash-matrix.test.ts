/**
 * M1 crash matrix: real child processes, real SIGKILL, real SQLite journal,
 * real HTTP provider. Every scenario asserts the primary invariant:
 *
 *   one logical non-replayable effect never silently moves the provider
 *   counter past 1, and uncertain state is settled only by reconciliation.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SqliteEffectJournal } from "../src/index.js";
import { startCounterProvider, type CounterProvider } from "./fixtures/counter-provider.js";

const CHILD = fileURLToPath(new URL("./fixtures/effect-child.js", import.meta.url));

interface ChildRun {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Async spawn is REQUIRED here: the mock provider runs inside this parent
 * process, so blocking the event loop (spawnSync) would deadlock the child's
 * HTTP execute/reconcile calls against a frozen server.
 */
function runChild(dbPath: string, baseUrl: string, crashPoint: string, key: string): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dbPath, baseUrl, crashPoint, key], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function readStatus(dbPath: string): Promise<string | undefined> {
  const journal = await SqliteEffectJournal.open({ path: dbPath });
  try {
    const records = await journal.list();
    return records[0]?.status;
  } finally {
    journal.close();
  }
}

/** Transition history as `from>to:cause` strings; asserts status/history agreement. */
async function readHistory(dbPath: string): Promise<string[]> {
  const journal = await SqliteEffectJournal.open({ path: dbPath });
  try {
    const histories = await journal.listHistory();
    if (histories.length === 0) {
      assert.equal((await journal.listEvents()).length, 0, "orphan events without a latest-state row");
      return [];
    }
    assert.equal(histories.length, 1);
    const history = histories[0]!;
    assert.equal(history.coverage, "observed");
    assert.equal(
      history.events.at(-1)?.toStatus,
      history.record.status,
      "latest-state row and last committed event disagree",
    );
    return history.events.map((e) => `${e.fromStatus ?? "-"}>${e.toStatus}:${e.cause}`);
  } finally {
    journal.close();
  }
}

interface Scenario {
  name: string;
  crash: string;
  /** Journal status observable after the crash (before restart). */
  statusAfterCrash: string | undefined;
  /** Provider counter right after the crash window settles. */
  counterAfterCrash: number;
  /** Expected final status after the restart child reconciles/resumes. */
  finalStatus: string;
  /** Expected provider counter after restart. */
  finalCounter: number;
  /** Committed transition events observable right after the crash. */
  historyAfterCrash: string[];
  /** Committed transition events after the restart child settles. */
  finalHistory: string[];
}

const PREPARE = "->PREPARED:prepare";
const SUBMIT = "PREPARED>SUBMITTED:submit";
const EXECUTED = "SUBMITTED>CONFIRMED:execute";
const RECONCILED_FOUND = "SUBMITTED>CONFIRMED:reconcile";
const RECONCILED_NOT_FOUND = "SUBMITTED>FAILED:reconcile";

const SCENARIOS: Scenario[] = [
  { name: "1 before PREPARED commit", crash: "before-prepared-commit", statusAfterCrash: undefined, counterAfterCrash: 0, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [], finalHistory: [PREPARE, SUBMIT, EXECUTED] },
  { name: "2 after PREPARED commit", crash: "after-prepared-commit", statusAfterCrash: "PREPARED", counterAfterCrash: 0, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [PREPARE], finalHistory: [PREPARE, SUBMIT, EXECUTED] },
  { name: "3 immediately before POST", crash: "before-execute", statusAfterCrash: "SUBMITTED", counterAfterCrash: 0, finalStatus: "FAILED", finalCounter: 0, historyAfterCrash: [PREPARE, SUBMIT], finalHistory: [PREPARE, SUBMIT, RECONCILED_NOT_FOUND] },
  { name: "4 after request leaves client", crash: "after-send", statusAfterCrash: "SUBMITTED", counterAfterCrash: 1, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [PREPARE, SUBMIT], finalHistory: [PREPARE, SUBMIT, RECONCILED_FOUND] },
  { name: "5 after remote commit, before response", crash: "after-remote-commit", statusAfterCrash: "SUBMITTED", counterAfterCrash: 1, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [PREPARE, SUBMIT], finalHistory: [PREPARE, SUBMIT, RECONCILED_FOUND] },
  { name: "6 after response, before CONFIRMED commit", crash: "after-execute-before-confirm", statusAfterCrash: "SUBMITTED", counterAfterCrash: 1, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [PREPARE, SUBMIT], finalHistory: [PREPARE, SUBMIT, RECONCILED_FOUND] },
  { name: "7 after CONFIRMED commit", crash: "after-confirm", statusAfterCrash: "CONFIRMED", counterAfterCrash: 1, finalStatus: "CONFIRMED", finalCounter: 1, historyAfterCrash: [PREPARE, SUBMIT, EXECUTED], finalHistory: [PREPARE, SUBMIT, EXECUTED] },
];

async function settle(provider: CounterProvider, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (provider.state().counter >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("M1 crash matrix (SIGKILL at effect boundaries)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, { timeout: 120_000 }, async () => {
      const provider = await startCounterProvider();
      const tmp = mkdtempSync(join(tmpdir(), "relay-m1-"));
      const dbPath = join(tmp, "storage.db");
      const key = "counter/increment:1";
      try {
        // Phase 1: run the effect child with the crash injection.
        const crashed = await runChild(dbPath, provider.baseUrl, scenario.crash, key);
        assert.ok(
          crashed.signal === "SIGKILL" || (crashed.status !== 0 && crashed.status !== null),
          `child should have died at ${scenario.crash}: status=${String(crashed.status)} signal=${String(crashed.signal)} stderr=${crashed.stderr}`,
        );

        // Phase 2: observe persisted state and remote truth after the crash.
        await settle(provider, scenario.counterAfterCrash);
        assert.equal(provider.state().counter, scenario.counterAfterCrash);
        assert.equal(await readStatus(dbPath), scenario.statusAfterCrash);
        const historyAfterCrash = await readHistory(dbPath);
        assert.deepEqual(historyAfterCrash, scenario.historyAfterCrash);
        // No event may claim a confirmed execution the provider never committed.
        assert.ok(
          historyAfterCrash.filter((e) => e.endsWith(">CONFIRMED:execute")).length <= provider.state().counter,
          "CONFIRMED event without a remote commit",
        );

        // Phase 3: restart (fresh process, same journal, same key).
        const restarted = await runChild(dbPath, provider.baseUrl, "none", key);
        assert.equal(
          restarted.status,
          0,
          `restart child failed: ${restarted.stderr}\n${restarted.stdout}`,
        );
        const outcome = JSON.parse(restarted.stdout.trim()) as { status: string };
        assert.equal(outcome.status, scenario.finalStatus.toLowerCase());
        assert.equal(await readStatus(dbPath), scenario.finalStatus);
        // Stored transition order equals what the fake provider actually saw:
        // a CONFIRMED-by-execute event only when the restart child executed,
        // a reconcile event only when it observed the provider read-only.
        assert.deepEqual(await readHistory(dbPath), scenario.finalHistory);

        // Phase 4: the invariant — counter never silently exceeds 1.
        assert.equal(provider.state().counter, scenario.finalCounter);
        assert.ok(provider.state().counter <= 1, "silent duplicate unsafe effect detected");
      } finally {
        await provider.stop();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("repeated restarts never duplicate a confirmed effect", { timeout: 60_000 }, async () => {
    const provider = await startCounterProvider();
    const tmp = mkdtempSync(join(tmpdir(), "relay-m1-"));
    const dbPath = join(tmp, "storage.db");
    try {
      const first = await runChild(dbPath, provider.baseUrl, "none", "counter/increment:1");
      assert.equal(first.status, 0);
      for (let i = 0; i < 3; i += 1) {
        const repeat = await runChild(dbPath, provider.baseUrl, "none", "counter/increment:1");
        assert.equal(repeat.status, 0, repeat.stderr);
        const outcome = JSON.parse(repeat.stdout.trim()) as { status: string; deduplicated?: boolean };
        assert.equal(outcome.status, "confirmed");
        assert.equal(outcome.deduplicated, true);
      }
      assert.equal(provider.state().counter, 1);
      // Deduplicated re-entries are not transitions: no invented recovery events.
      assert.deepEqual(await readHistory(dbPath), [PREPARE, SUBMIT, EXECUTED]);
    } finally {
      await provider.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("idempotent provider mode replays the stored response without a second increment", async () => {
    const provider = await startCounterProvider();
    try {
      const url = (mode: string) => {
        const u = new URL("/increment", provider.baseUrl);
        u.searchParams.set("key", "counter/increment:idem");
        u.searchParams.set("mode", mode);
        return u;
      };
      const first = await fetch(url("idempotent"), { method: "POST" });
      const second = await fetch(url("idempotent"), { method: "POST" });
      const a = (await first.json()) as { remoteRef: string; value: number; deduplicated?: boolean };
      const b = (await second.json()) as { remoteRef: string; value: number; deduplicated?: boolean };
      assert.equal(a.value, 1);
      assert.equal(b.value, 1);
      assert.equal(b.deduplicated, true);
      assert.equal(a.remoteRef, b.remoteRef);
      assert.equal(provider.state().counter, 1);
    } finally {
      await provider.stop();
    }
  });
});
