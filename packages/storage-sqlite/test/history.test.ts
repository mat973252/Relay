/**
 * Effect transition evidence (tasks/NEXT_ITERATION_EFFECT_EVIDENCE_HISTORY.md).
 *
 * Every committed latest-state transition of `relay_effects` must be
 * accompanied, in the SAME SQLite transaction, by one append-only row in
 * `relay_effect_events`. The latest-state row stays authoritative; the
 * history only records what Relay actually observed. Legacy databases get
 * no backfilled transitions and expose their rows as snapshots with history
 * `unavailable` (or `partial` once new transitions are recorded).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runEffect, AmbiguousEffectError, type EffectRecord, type EffectTransitionEvent } from "@relay/core";
import { SqliteEffectJournal } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-history-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function prepared(id: string, key: string, at: number): EffectRecord {
  return {
    id,
    key,
    kind: "test/kind",
    requestHash: `hash-${id}`,
    replay: "never",
    status: "PREPARED",
    remoteRef: undefined,
    resultJson: undefined,
    reason: undefined,
    createdAt: at,
    submittedAt: undefined,
    settledAt: undefined,
    updatedAt: at,
  };
}

function shape(events: EffectTransitionEvent[]): [string | undefined, string, string][] {
  return events.map((e) => [e.fromStatus, e.toStatus, e.cause]);
}

describe("effect transition evidence", () => {
  it("records one event per committed transition with cause, in order, across reopen", async () => {
    const dbPath = join(tmp, "events.db");
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    await journal.insertPrepared(prepared("e1", "k/1", 1));
    await journal.markSubmitted("e1", 2);
    await journal.markUnknown("e1", "ambiguous: reset", 3, "execute");
    await journal.markUnknown("e1", "reconcile uncertain: pending", 4, "reconcile");
    await journal.markConfirmed("e1", { remoteRef: "fx-1", resultJson: "{\"v\":1}", at: 5, cause: "reconcile" });
    journal.close();

    const reopened = await SqliteEffectJournal.open({ path: dbPath });
    try {
      const [history] = await reopened.listHistory("k/1");
      assert.ok(history !== undefined);
      assert.equal(history.coverage, "observed");
      assert.equal(history.record.status, "CONFIRMED");
      assert.deepEqual(shape(history.events), [
        [undefined, "PREPARED", "prepare"],
        ["PREPARED", "SUBMITTED", "submit"],
        ["SUBMITTED", "UNKNOWN", "execute"],
        ["UNKNOWN", "UNKNOWN", "reconcile"],
        ["UNKNOWN", "CONFIRMED", "reconcile"],
      ]);
      assert.deepEqual(history.events.map((e) => e.at), [1, 2, 3, 4, 5]);
      assert.deepEqual(history.events.map((e) => e.reason), [
        undefined,
        undefined,
        "ambiguous: reset",
        "reconcile uncertain: pending",
        undefined,
      ]);
      assert.equal(history.events[4]?.remoteRef, "fx-1");
      assert.ok(history.events.every((e) => e.effectId === "e1" && e.key === "k/1" && e.kind === "test/kind"));
      const seqs = history.events.map((e) => e.seq);
      assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "seq is monotonic");
      assert.equal(new Set(seqs).size, seqs.length);
    } finally {
      reopened.close();
    }
  });

  it("a rejected transition appends no event and leaves status/history consistent", async () => {
    const journal = await SqliteEffectJournal.open({ path: join(tmp, "rejected.db") });
    try {
      await journal.insertPrepared(prepared("e2", "k/2", 1));
      await journal.markSubmitted("e2", 2);
      await journal.markConfirmed("e2", { remoteRef: undefined, resultJson: "null", at: 3, cause: "execute" });
      await assert.rejects(() => journal.markFailed("e2", "late", 4, "execute"), /invalid effect transition/);
      await assert.rejects(() => journal.markSubmitted("e2", 5), /invalid effect transition/);
      await assert.rejects(() => journal.markUnknown("missing", "x", 6, "execute"), /invalid effect transition/);
      const [history] = await journal.listHistory("k/2");
      assert.ok(history !== undefined);
      assert.equal(history.events.length, 3);
      assert.equal(history.events.at(-1)?.toStatus, history.record.status);
      assert.equal((await journal.listEvents()).length, 3);
    } finally {
      journal.close();
    }
  });

  it("a cause the caller does not know is recorded as explicit unknown, never guessed", async () => {
    const journal = await SqliteEffectJournal.open({ path: join(tmp, "unknown-cause.db") });
    try {
      await journal.insertPrepared(prepared("e3", "k/3", 1));
      await journal.markSubmitted("e3", 2);
      await journal.markFailed("e3", "legacy caller", 3);
      const [history] = await journal.listHistory("k/3");
      assert.deepEqual(shape(history?.events ?? []), [
        [undefined, "PREPARED", "prepare"],
        ["PREPARED", "SUBMITTED", "submit"],
        ["SUBMITTED", "FAILED", "unknown"],
      ]);
    } finally {
      journal.close();
    }
  });

  it("legacy database: no backfill, snapshot labeled unavailable, later transitions labeled partial", async () => {
    const dbPath = join(tmp, "legacy.db");
    // Build a pre-history journal by hand: only the latest-state table exists.
    const sqlite = await import("node:sqlite");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE relay_effects (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
        replay TEXT NOT NULL, status TEXT NOT NULL, remote_ref TEXT, result_json TEXT, reason TEXT,
        created_at INTEGER NOT NULL, submitted_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL
      );
      INSERT INTO relay_effects VALUES ('old-1','legacy/confirmed','k','h','never','CONFIRMED','fx-old',NULL,NULL,1,2,3,3);
      INSERT INTO relay_effects VALUES ('old-2','legacy/unknown','k','h2','never','UNKNOWN',NULL,NULL,'ambiguous',4,5,NULL,6);
    `);
    raw.close();

    const journal = await SqliteEffectJournal.open({ path: dbPath });
    try {
      assert.equal((await journal.listEvents()).length, 0, "no fabricated transitions");
      const histories = await journal.listHistory();
      assert.equal(histories.length, 2);
      for (const h of histories) {
        assert.equal(h.coverage, "unavailable");
        assert.deepEqual(h.events, []);
      }
      assert.equal(histories.find((h) => h.record.key === "legacy/confirmed")?.record.status, "CONFIRMED");

      // A transition observed after the upgrade is recorded from the row's
      // actual prior status; earlier history stays explicitly missing.
      await journal.markConfirmed("old-2", { remoteRef: "fx-2", resultJson: "null", at: 7, cause: "reconcile" });
      const [h] = await journal.listHistory("legacy/unknown");
      assert.ok(h !== undefined);
      assert.equal(h.coverage, "partial");
      assert.deepEqual(shape(h.events), [["UNKNOWN", "CONFIRMED", "reconcile"]]);
      assert.equal(h.record.status, "CONFIRMED");
    } finally {
      journal.close();
    }

    // Repeated open is idempotent on an already-migrated database.
    const again = await SqliteEffectJournal.open({ path: dbPath });
    try {
      assert.equal((await again.listEvents()).length, 1);
    } finally {
      again.close();
    }
  });

  it("replaceAll installs records with their events atomically and never alters the latest state", async () => {
    const journal = await SqliteEffectJournal.open({ path: join(tmp, "replace.db") });
    try {
      await journal.insertPrepared(prepared("stale", "stale/1", 1));
      const record: EffectRecord = { ...prepared("imp-1", "imp/1", 10), status: "SUBMITTED", submittedAt: 11, updatedAt: 11 };
      const events: EffectTransitionEvent[] = [
        { seq: 7, effectId: "imp-1", key: "imp/1", kind: "test/kind", fromStatus: undefined, toStatus: "PREPARED", cause: "prepare", reason: undefined, remoteRef: undefined, at: 10 },
        { seq: 9, effectId: "imp-1", key: "imp/1", kind: "test/kind", fromStatus: "PREPARED", toStatus: "SUBMITTED", cause: "submit", reason: undefined, remoteRef: undefined, at: 11 },
      ];
      await journal.replaceAll([record], events);
      assert.equal((await journal.list()).length, 1);
      const [h] = await journal.listHistory("imp/1");
      assert.ok(h !== undefined);
      assert.equal(h.record.status, "SUBMITTED");
      assert.equal(h.coverage, "observed");
      assert.deepEqual(h.events.map((e) => e.seq), [7, 9]);
      // New events continue after the imported sequence.
      await journal.markUnknown("imp-1", "ambiguous", 12, "execute");
      const all = await journal.listEvents();
      assert.equal(all.length, 3);
      assert.ok((all[2]?.seq ?? 0) > 9);

      // replaceAll without events: rows become snapshots with history unavailable.
      await journal.replaceAll([record]);
      const [snapshot] = await journal.listHistory();
      assert.equal(snapshot?.coverage, "unavailable");
      assert.equal((await journal.listEvents()).length, 0);
    } finally {
      journal.close();
    }
  });

  it("runEffect attributes causes: execute vs reconcile, and dedup adds no event", async () => {
    const journal = await SqliteEffectJournal.open({ path: join(tmp, "runner.db") });
    try {
      let t = 100;
      const base = {
        key: "run/1",
        kind: "test/kind",
        request: { a: 1 },
        replay: "never" as const,
        journal,
        now: () => (t += 1),
      };
      const first = await runEffect({
        ...base,
        execute: async () => {
          throw new AmbiguousEffectError("socket hang up");
        },
      });
      assert.equal(first.status, "unknown");
      const second = await runEffect({
        ...base,
        execute: async () => {
          throw new Error("must not execute");
        },
        reconcile: async () => ({ found: "uncertain", reason: "pending" }),
      });
      assert.equal(second.status, "unknown");
      const third = await runEffect({
        ...base,
        execute: async () => {
          throw new Error("must not execute");
        },
        reconcile: async () => ({ found: true, remoteRef: "fx-r", result: { ok: true } }),
      });
      assert.equal(third.status, "confirmed");
      const fourth = await runEffect({
        ...base,
        execute: async () => {
          throw new Error("must not execute");
        },
      });
      assert.equal(fourth.status, "confirmed");
      assert.equal(fourth.status === "confirmed" && fourth.deduplicated, true);

      const [h] = await journal.listHistory("run/1");
      assert.ok(h !== undefined);
      assert.deepEqual(shape(h.events), [
        [undefined, "PREPARED", "prepare"],
        ["PREPARED", "SUBMITTED", "submit"],
        ["SUBMITTED", "UNKNOWN", "execute"],
        ["UNKNOWN", "UNKNOWN", "reconcile"],
        ["UNKNOWN", "CONFIRMED", "reconcile"],
      ]);
      assert.equal(h.events.at(-1)?.remoteRef, "fx-r");
    } finally {
      journal.close();
    }
  });

  it("runEffect attributes definitive execute failure and reconcile not-found to their causes", async () => {
    const journal = await SqliteEffectJournal.open({ path: join(tmp, "runner2.db") });
    try {
      await runEffect({
        key: "run/fail",
        kind: "test/kind",
        request: {},
        replay: "never",
        journal,
        execute: async () => {
          throw new Error("HTTP 400");
        },
      });
      await runEffect({
        key: "run/nf",
        kind: "test/kind",
        request: {},
        replay: "never",
        journal,
        execute: async () => {
          throw new AmbiguousEffectError("timeout");
        },
      });
      await runEffect({
        key: "run/nf",
        kind: "test/kind",
        request: {},
        replay: "never",
        journal,
        execute: async () => {
          throw new Error("must not execute");
        },
        reconcile: async () => ({ found: false }),
      });
      const [fail] = await journal.listHistory("run/fail");
      assert.deepEqual(shape(fail?.events ?? []).at(-1), ["SUBMITTED", "FAILED", "execute"]);
      const [nf] = await journal.listHistory("run/nf");
      assert.deepEqual(shape(nf?.events ?? []).at(-1), ["UNKNOWN", "FAILED", "reconcile"]);
      const ok = await runEffect({
        key: "run/ok",
        kind: "test/kind",
        request: {},
        replay: "never",
        journal,
        execute: async () => ({ remoteRef: "fx-ok" }),
      });
      assert.equal(ok.status, "confirmed");
      const [okh] = await journal.listHistory("run/ok");
      assert.deepEqual(shape(okh?.events ?? []).at(-1), ["SUBMITTED", "CONFIRMED", "execute"]);
      assert.equal(okh?.events.at(-1)?.remoteRef, "fx-ok");
    } finally {
      journal.close();
    }
  });
});
