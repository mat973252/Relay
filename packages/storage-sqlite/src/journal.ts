/**
 * @relay/storage-sqlite — durable effect journal (M1).
 *
 * One row per semantic key in `relay_effects` (the execution authority),
 * plus an append-only `relay_effect_events` row per committed transition,
 * written in the same transaction as the row update. Commits are
 * synchronous through `node:sqlite` with WAL + synchronous=FULL so a SIGKILL
 * between statements never loses a committed status transition and never
 * leaves a transition without its event (or vice versa). This is
 * Relay-owned state; it is NOT a Pi session store.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  EffectHistory,
  EffectHistoryReader,
  EffectJournal,
  EffectRecord,
  EffectStatus,
  EffectTransitionCause,
  EffectTransitionEvent,
} from "@relay/core";

interface EffectRow {
  id: string;
  key: string;
  kind: string;
  request_hash: string;
  intent_json: string | null;
  replay: string;
  status: string;
  remote_ref: string | null;
  result_json: string | null;
  reason: string | null;
  created_at: number;
  submitted_at: number | null;
  settled_at: number | null;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_effects (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  replay       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED','UNKNOWN')),
  remote_ref   TEXT,
  result_json  TEXT,
  reason       TEXT,
  created_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  settled_at   INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_effect_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id   TEXT NOT NULL REFERENCES relay_effects(id),
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  from_status TEXT CHECK (from_status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED','UNKNOWN')),
  to_status   TEXT NOT NULL CHECK (to_status IN ('PREPARED','SUBMITTED','CONFIRMED','FAILED','UNKNOWN')),
  cause       TEXT NOT NULL CHECK (cause IN ('prepare','submit','execute','reconcile','unknown')),
  reason      TEXT,
  remote_ref  TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_effect_events_effect ON relay_effect_events(effect_id, seq);
`;

interface EventRow {
  seq: number;
  effect_id: string;
  key: string;
  kind: string;
  from_status: string | null;
  to_status: string;
  cause: string;
  reason: string | null;
  remote_ref: string | null;
  at: number;
}

function toEvent(row: EventRow): EffectTransitionEvent {
  return {
    seq: row.seq,
    effectId: row.effect_id,
    key: row.key,
    kind: row.kind,
    fromStatus: (row.from_status ?? undefined) as EffectStatus | undefined,
    toStatus: row.to_status as EffectStatus,
    cause: row.cause as EffectTransitionCause,
    reason: row.reason ?? undefined,
    remoteRef: row.remote_ref ?? undefined,
    at: row.at,
  };
}

const INSERT_EVENT = `INSERT INTO relay_effect_events
  (effect_id, key, kind, from_status, to_status, cause, reason, remote_ref, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_EVENT_WITH_SEQ = `INSERT INTO relay_effect_events
  (seq, effect_id, key, kind, from_status, to_status, cause, reason, remote_ref, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_RECORD = `INSERT INTO relay_effects
  (id, key, kind, request_hash, intent_json, replay, status, remote_ref, result_json, reason,
   created_at, submitted_at, settled_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function toRecord(row: EffectRow): EffectRecord {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    requestHash: row.request_hash,
    intentJson: row.intent_json ?? undefined,
    replay: row.replay as EffectRecord["replay"],
    status: row.status as EffectRecord["status"],
    remoteRef: row.remote_ref ?? undefined,
    resultJson: row.result_json ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    submittedAt: row.submitted_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export interface SqliteEffectJournalOptions {
  /** Filesystem path of the SQLite database file. */
  path: string;
}

export class SqliteEffectJournal implements EffectJournal, EffectHistoryReader {
  private readonly db: import("node:sqlite").DatabaseSync;

  private constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
  }

  static async open(options: SqliteEffectJournalOptions): Promise<SqliteEffectJournal> {
    const sqlite = await import("node:sqlite");
    await mkdir(dirname(options.path), { recursive: true });
    const db = new sqlite.DatabaseSync(options.path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // Idempotent: CREATE IF NOT EXISTS only. Existing rows are never
    // backfilled with invented transitions; their history reads `unavailable`.
    db.exec(SCHEMA);
    // Migration for journals created before intent recovery metadata existed.
    try {
      db.exec("ALTER TABLE relay_effects ADD COLUMN intent_json TEXT");
    } catch {
      // column already present
    }
    return new SqliteEffectJournal(db);
  }

  close(): void {
    this.db.close();
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Capsule import path: atomically replaces the whole journal content.
   * Events are installed verbatim (including seq) only when supplied and
   * only for records present in `records`; without events the imported rows
   * are snapshots whose history reads `unavailable`. Nothing is inferred.
   */
  async replaceAll(records: EffectRecord[], events: EffectTransitionEvent[] = []): Promise<void> {
    const ids = new Set(records.map((r) => r.id));
    for (const event of events) {
      if (!ids.has(event.effectId)) throw new Error(`effect evidence orphan: ${event.effectId}`);
    }
    this.transaction(() => {
      this.db.exec("DELETE FROM relay_effect_events");
      this.db.exec("DELETE FROM relay_effects");
      const insertRecord = this.db.prepare(INSERT_RECORD);
      for (const record of records) {
        insertRecord.run(
          record.id,
          record.key,
          record.kind,
          record.requestHash,
          record.intentJson ?? null,
          record.replay,
          record.status,
          record.remoteRef ?? null,
          record.resultJson ?? null,
          record.reason ?? null,
          record.createdAt,
          record.submittedAt ?? null,
          record.settledAt ?? null,
          record.updatedAt,
        );
      }
      const insertEvent = this.db.prepare(INSERT_EVENT_WITH_SEQ);
      for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
        insertEvent.run(
          event.seq,
          event.effectId,
          event.key,
          event.kind,
          event.fromStatus ?? null,
          event.toStatus,
          event.cause,
          event.reason ?? null,
          event.remoteRef ?? null,
          event.at,
        );
      }
    });
  }

  private appendEvent(
    row: EffectRow,
    fromStatus: EffectStatus | undefined,
    toStatus: EffectStatus,
    cause: EffectTransitionCause,
    reason: string | undefined,
    remoteRef: string | undefined,
    at: number,
  ): void {
    this.db
      .prepare(INSERT_EVENT)
      .run(row.id, row.key, row.kind, fromStatus ?? null, toStatus, cause, reason ?? null, remoteRef ?? null, at);
  }

  private rowForUpdate(id: string): EffectRow | undefined {
    const row = this.db.prepare("SELECT * FROM relay_effects WHERE id = ?").get(id);
    return row as unknown as EffectRow | undefined;
  }

  /**
   * Row update + event append in one transaction. `changes !== 1` means the
   * guard rejected the transition: nothing is committed and no event exists.
   */
  private transition(
    id: string,
    toStatus: EffectStatus,
    cause: EffectTransitionCause,
    at: number,
    update: (row: EffectRow) => number,
    evidence: { reason: string | undefined; remoteRef: string | undefined },
  ): void {
    this.transaction(() => {
      const row = this.rowForUpdate(id);
      const changes = row === undefined ? 0 : update(row);
      if (row === undefined || changes !== 1) {
        throw new Error(`invalid effect transition to ${toStatus}: ${id}`);
      }
      this.appendEvent(row, row.status as EffectStatus, toStatus, cause, evidence.reason, evidence.remoteRef, at);
    });
  }

  async insertPrepared(record: EffectRecord): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO relay_effects
             (id, key, kind, request_hash, intent_json, replay, status, remote_ref, result_json, reason,
              created_at, submitted_at, settled_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', NULL, NULL, NULL, ?, NULL, NULL, ?)`,
        )
        .run(record.id, record.key, record.kind, record.requestHash, record.intentJson ?? null, record.replay, record.createdAt, record.updatedAt);
      this.appendEvent(
        { id: record.id, key: record.key, kind: record.kind } as EffectRow,
        undefined,
        "PREPARED",
        "prepare",
        undefined,
        undefined,
        record.createdAt,
      );
    });
  }

  /** PREPARED -> SUBMITTED has exactly one meaning, so its default cause is `submit`. */
  async markSubmitted(id: string, at: number, cause: EffectTransitionCause = "submit"): Promise<void> {
    this.transition(
      id,
      "SUBMITTED",
      cause,
      at,
      () =>
        this.db
          .prepare("UPDATE relay_effects SET status = 'SUBMITTED', submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'PREPARED'")
          .run(at, at, id).changes as number,
      { reason: undefined, remoteRef: undefined },
    );
  }

  async markConfirmed(
    id: string,
    patch: { remoteRef: string | undefined; resultJson: string | undefined; at: number; cause?: EffectTransitionCause },
  ): Promise<void> {
    this.transition(
      id,
      "CONFIRMED",
      patch.cause ?? "unknown",
      patch.at,
      () =>
        this.db
          .prepare(
            `UPDATE relay_effects
             SET status = 'CONFIRMED', remote_ref = ?, result_json = ?, settled_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')`,
          )
          .run(patch.remoteRef ?? null, patch.resultJson ?? null, patch.at, patch.at, id).changes as number,
      { reason: undefined, remoteRef: patch.remoteRef },
    );
  }

  async markFailed(id: string, reason: string, at: number, cause: EffectTransitionCause = "unknown"): Promise<void> {
    this.transition(
      id,
      "FAILED",
      cause,
      at,
      () =>
        this.db
          .prepare("UPDATE relay_effects SET status = 'FAILED', reason = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')")
          .run(reason, at, at, id).changes as number,
      { reason, remoteRef: undefined },
    );
  }

  async markUnknown(id: string, reason: string, at: number, cause: EffectTransitionCause = "unknown"): Promise<void> {
    this.transition(
      id,
      "UNKNOWN",
      cause,
      at,
      () =>
        this.db
          .prepare("UPDATE relay_effects SET status = 'UNKNOWN', reason = ?, updated_at = ? WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')")
          .run(reason, at, id).changes as number,
      { reason, remoteRef: undefined },
    );
  }

  /** Read-only: all committed transitions in append order, optionally for one effect id. */
  async listEvents(effectId?: string): Promise<EffectTransitionEvent[]> {
    const rows =
      effectId === undefined
        ? this.db.prepare("SELECT * FROM relay_effect_events ORDER BY seq").all()
        : this.db.prepare("SELECT * FROM relay_effect_events WHERE effect_id = ? ORDER BY seq").all(effectId);
    return (rows as unknown as EventRow[]).map(toEvent);
  }

  /**
   * Read-only: latest-state row plus its observed transitions. Coverage is
   * derived from what exists, never inferred: `observed` when the chain
   * starts at the insert, `partial` when it starts mid-life (legacy row
   * transitioned after the event table existed), `unavailable` when empty.
   */
  async listHistory(key?: string): Promise<EffectHistory[]> {
    const records = key === undefined ? await this.list() : [await this.getByKey(key)].filter((r) => r !== undefined);
    const events = await this.listEvents();
    const byEffect = new Map<string, EffectTransitionEvent[]>();
    for (const event of events) {
      const list = byEffect.get(event.effectId) ?? [];
      list.push(event);
      byEffect.set(event.effectId, list);
    }
    return records.map((record) => {
      const own = byEffect.get(record.id) ?? [];
      const coverage: EffectHistory["coverage"] =
        own.length === 0 ? "unavailable" : own[0]!.fromStatus === undefined ? "observed" : "partial";
      return { record, events: own, coverage };
    });
  }

  async get(id: string): Promise<EffectRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_effects WHERE id = ?").get(id);
    return row === undefined ? undefined : toRecord(row as unknown as EffectRow);
  }

  async getByKey(key: string): Promise<EffectRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_effects WHERE key = ?").get(key);
    return row === undefined ? undefined : toRecord(row as unknown as EffectRow);
  }

  async list(): Promise<EffectRecord[]> {
    const rows = this.db.prepare("SELECT * FROM relay_effects ORDER BY created_at, id").all();
    return (rows as unknown as EffectRow[]).map(toRecord);
  }
}
