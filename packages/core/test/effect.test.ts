/**
 * M1 unit tests for the External Effect Guard state machine, using an
 * in-memory journal whose contents survive "process death" (a fresh
 * runEffect closure models a restarted process sharing persisted state).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmbiguousEffectError,
  EffectNeedsReconciliationError,
  SimulatedProcessDeath,
  hashRequest,
  runEffect,
  stableStringify,
  type EffectJournal,
  type EffectRecord,
  type ReconcileOutcome,
} from "../src/index.js";

class MemoryJournal implements EffectJournal {
  readonly rows = new Map<string, EffectRecord>();

  private byId(id: string): EffectRecord {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no journal row ${id}`);
    return row;
  }

  async insertPrepared(record: EffectRecord): Promise<void> {
    if (record.key !== undefined && [...this.rows.values()].some((r) => r.key === record.key)) {
      throw new Error(`duplicate key ${record.key}`);
    }
    this.rows.set(record.id, { ...record });
  }

  async markSubmitted(id: string, at: number): Promise<void> {
    const row = this.byId(id);
    row.status = "SUBMITTED";
    row.submittedAt = at;
    row.updatedAt = at;
  }

  async markConfirmed(
    id: string,
    patch: { remoteRef: string | undefined; resultJson: string | undefined; at: number },
  ): Promise<void> {
    const row = this.byId(id);
    row.status = "CONFIRMED";
    row.remoteRef = patch.remoteRef;
    row.resultJson = patch.resultJson;
    row.settledAt = patch.at;
    row.updatedAt = patch.at;
  }

  async markFailed(id: string, reason: string, at: number): Promise<void> {
    const row = this.byId(id);
    row.status = "FAILED";
    row.reason = reason;
    row.settledAt = at;
    row.updatedAt = at;
  }

  async markUnknown(id: string, reason: string, at: number): Promise<void> {
    const row = this.byId(id);
    row.status = "UNKNOWN";
    row.reason = reason;
    row.updatedAt = at;
  }

  async get(id: string): Promise<EffectRecord | undefined> {
    return this.rows.get(id);
  }

  async getByKey(key: string): Promise<EffectRecord | undefined> {
    return [...this.rows.values()].find((r) => r.key === key);
  }

  async list(): Promise<EffectRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

function makeInput(journal: MemoryJournal) {
  let clock = 1_000;
  const now = () => clock++;
  let executions = 0;
  const input = {
    key: "counter/increment:1",
    kind: "http-counter/increment",
    request: { amount: 1 },
    replay: "never" as const,
    journal,
    now,
    execute: async () => {
      executions += 1;
      return { remoteRef: "fx-1", value: executions };
    },
  };
  return { input, executionCount: () => executions };
}

describe("request hashing", () => {
  it("stableStringify is key-order independent", () => {
    assert.equal(stableStringify({ a: 1, b: { d: 4, c: 3 } }), stableStringify({ b: { c: 3, d: 4 }, a: 1 }));
  });
  it("hashRequest distinguishes different requests", () => {
    assert.notEqual(hashRequest({ amount: 1 }), hashRequest({ amount: 2 }));
  });
  it("hashRequest is stable across key order", () => {
    assert.equal(hashRequest({ a: 1, b: 2 }), hashRequest({ b: 2, a: 1 }));
  });
});

describe("runEffect fresh path", () => {
  it("PREPARED -> SUBMITTED -> CONFIRMED with result and remoteRef", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    const outcome = await runEffect(input);
    assert.equal(outcome.status, "confirmed");
    assert.ok(outcome.status === "confirmed");
    assert.equal(outcome.remoteRef, "fx-1");
    assert.equal(outcome.deduplicated, false);
    assert.equal(outcome.reconciled, false);
    assert.equal(executionCount(), 1);
    const [record] = await journal.list();
    assert.ok(record !== undefined);
    assert.equal(record.status, "CONFIRMED");
    assert.ok(record.submittedAt !== undefined);
    assert.ok(record.settledAt !== undefined);
  });

  it("re-entry after CONFIRMED deduplicates without executing again", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await runEffect(input);
    const second = await runEffect(input);
    assert.ok(second.status === "confirmed");
    assert.equal(second.deduplicated, true);
    assert.equal(executionCount(), 1);
  });

  it("rejects reuse of a semantic key for a different request or kind", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await runEffect(input);
    await assert.rejects(() => runEffect({ ...input, request: { amount: 2 } }), /semantic key.*different effect/);
    await assert.rejects(() => runEffect({ ...input, kind: "other" }), /semantic key.*different effect/);
    assert.equal(executionCount(), 1);
  });

  it("definitive execute failure is FAILED (terminal on re-entry)", async () => {
    const journal = new MemoryJournal();
    const { input } = makeInput(journal);
    let calls = 0;
    input.execute = async () => {
      calls += 1;
      throw new Error("400 Bad Request");
    };
    const outcome = await runEffect(input);
    assert.ok(outcome.status === "failed");
    assert.match(outcome.reason, /400 Bad Request/);
    assert.equal(calls, 1);
    const second = await runEffect(input);
    assert.ok(second.status === "failed");
    assert.equal(calls, 1);
  });

  it("ambiguous execute failure is UNKNOWN and blocks re-entry without reconcile", async () => {
    const journal = new MemoryJournal();
    const { input } = makeInput(journal);
    input.execute = async () => {
      throw new AmbiguousEffectError("connection reset after send");
    };
    const outcome = await runEffect(input);
    assert.ok(outcome.status === "unknown");
    const [record] = await journal.list();
    assert.ok(record !== undefined);
    assert.equal(record.status, "UNKNOWN");
    await assert.rejects(
      () => runEffect({ ...input, execute: async () => "should-not-run" }),
      EffectNeedsReconciliationError,
    );
  });
});

describe("runEffect re-entry reconciliation", () => {
  async function seed(journal: MemoryJournal, status: "PREPARED" | "SUBMITTED" | "UNKNOWN"): Promise<void> {
    const record: EffectRecord = {
      id: "seed-1",
      key: "counter/increment:1",
      kind: "http-counter/increment",
      requestHash: hashRequest({ amount: 1 }),
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: 1,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: 1,
    };
    await journal.insertPrepared(record);
    if (status !== "PREPARED") await journal.markSubmitted("seed-1", 2);
    if (status === "UNKNOWN") await journal.markUnknown("seed-1", "seed ambiguous", 3);
  }

  it("SUBMITTED + reconcile found -> CONFIRMED without executing", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await seed(journal, "SUBMITTED");
    const reconcile = async (): Promise<ReconcileOutcome> => ({
      found: true,
      remoteRef: "fx-remote-9",
      result: { value: 9 },
    });
    const outcome = await runEffect({ ...input, reconcile });
    assert.ok(outcome.status === "confirmed");
    assert.equal(outcome.reconciled, true);
    assert.equal(outcome.remoteRef, "fx-remote-9");
    assert.equal(executionCount(), 0);
  });

  it("UNKNOWN + reconcile uncertain -> stays UNKNOWN (never auto-retried)", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await seed(journal, "UNKNOWN");
    const reconcile = async (): Promise<ReconcileOutcome> => ({
      found: "uncertain",
      reason: "provider 503",
    });
    const outcome = await runEffect({ ...input, reconcile });
    assert.ok(outcome.status === "unknown");
    assert.match(outcome.reason, /provider 503/);
    const [record] = await journal.list();
    assert.ok(record !== undefined);
    assert.equal(record.status, "UNKNOWN");
    assert.equal(executionCount(), 0);
  });

  it("SUBMITTED + reconcile not-found -> FAILED, no silent re-execution", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await seed(journal, "SUBMITTED");
    const reconcile = async (): Promise<ReconcileOutcome> => ({ found: false });
    const outcome = await runEffect({ ...input, reconcile });
    assert.ok(outcome.status === "failed");
    assert.equal(outcome.reconciled, true);
    assert.match(outcome.reason, /forbids automatic re-execution/);
    assert.equal(executionCount(), 0);
    const [record] = await journal.list();
    assert.ok(record !== undefined);
    assert.equal(record.status, "FAILED");
  });

  it("PREPARED re-entry resumes by executing (safe continuation)", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    await seed(journal, "PREPARED");
    const outcome = await runEffect(input);
    assert.ok(outcome.status === "confirmed");
    assert.equal(outcome.reconciled, false);
    assert.equal(executionCount(), 1);
  });
});

describe("runEffect crash injection (simulated process death)", () => {
  const runnerPoints = [
    "before-prepared-commit",
    "after-prepared-commit",
    "before-execute",
    "after-execute-before-confirm",
    "after-confirm",
  ] as const;

  const expectedStatus: Record<(typeof runnerPoints)[number], EffectRecord["status"] | undefined> = {
    "before-prepared-commit": undefined,
    "after-prepared-commit": "PREPARED",
    "before-execute": "SUBMITTED",
    "after-execute-before-confirm": "SUBMITTED",
    "after-confirm": "CONFIRMED",
  };

  for (const point of runnerPoints) {
    it(`crash at ${point} leaves journal ${String(expectedStatus[point])}`, async () => {
      const journal = new MemoryJournal();
      const { input } = makeInput(journal);
      await assert.rejects(
        () =>
          runEffect({
            ...input,
            crash: { point, kill: (p) => { throw new SimulatedProcessDeath(p); } },
          }),
        (err: unknown) => err instanceof SimulatedProcessDeath && err.point === point,
      );
      const records = await journal.list();
      if (expectedStatus[point] === undefined) {
        assert.equal(records.length, 0);
      } else {
        assert.equal(records.length, 1);
        assert.equal(records[0]?.status, expectedStatus[point]);
      }
    });
  }

  it("restart after before-execute crash reconciles to CONFIRMED without duplicate execution", async () => {
    const journal = new MemoryJournal();
    const { input, executionCount } = makeInput(journal);
    // Simulated remote already committed the effect (crash after send).
    const remoteCommitted = new Map<string, { remoteRef: string; value: number }>([
      [input.key, { remoteRef: "fx-remote-1", value: 1 }],
    ]);
    await assert.rejects(
      () =>
        runEffect({
          ...input,
          crash: { point: "before-execute", kill: (p) => { throw new SimulatedProcessDeath(p); } },
        }),
      SimulatedProcessDeath,
    );
    const reconcile = async (record: EffectRecord): Promise<ReconcileOutcome> => {
      const hit = remoteCommitted.get(record.key);
      return hit === undefined
        ? { found: false }
        : { found: true, remoteRef: hit.remoteRef, result: { value: hit.value } };
    };
    const outcome = await runEffect({ ...input, reconcile });
    assert.ok(outcome.status === "confirmed");
    assert.equal(outcome.reconciled, true);
    assert.equal(executionCount(), 0);
    // The provider counter logically equals remoteCommitted.value: exactly 1.
  });
});
