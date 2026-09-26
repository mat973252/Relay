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
import { mkdir, stat } from "node:fs/promises";
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
    at: row.at,
  };
}

const INSERT_EVENT = `INSERT INTO relay_effect_events
  (effect_id, key, kind, from_status, to_status, cause, at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

const INSERT_EVENT_WITH_SEQ = `INSERT INTO relay_effect_events
  (seq, effect_id, key, kind, from_status, to_status, cause, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

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

/**
 * Journals created by an earlier revision of the event table carried
 * free-form `reason`/`remote_ref` columns. Evidence must hold controlled
 * values only, so those columns (and their retained text) are dropped in
 * place and the file is vacuumed so the dropped text does not linger in
 * free pages; seq, identity, statuses, cause and time are untouched.
 */
function dropFreeFormEventColumns(db: import("node:sqlite").DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(relay_effect_events)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  const extra = ["reason", "remote_ref"].filter((c) => columns.has(c));
  if (extra.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const column of extra) db.exec(`ALTER TABLE relay_effect_events DROP COLUMN ${column}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  db.exec("VACUUM");
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
    dropFreeFormEventColumns(db);
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
   * Read-only snapshot: a deferred transaction takes no write lock, but in
   * WAL every SELECT inside it sees the same committed state, so rows and
   * events read together can never straddle a concurrent commit.
   */
  private snapshot<T>(work: () => T): T {
    this.db.exec("BEGIN DEFERRED");
    try {
      return work();
    } finally {
      this.db.exec("COMMIT");
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
    at: number,
  ): void {
    this.db.prepare(INSERT_EVENT).run(row.id, row.key, row.kind, fromStatus ?? null, toStatus, cause, at);
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
  ): void {
    this.transaction(() => {
      const row = this.rowForUpdate(id);
      const changes = row === undefined ? 0 : update(row);
      if (row === undefined || changes !== 1) {
        throw new Error(`invalid effect transition to ${toStatus}: ${id}`);
      }
      this.appendEvent(row, row.status as EffectStatus, toStatus, cause, at);
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
    );
  }

  /** Read-only: all committed transitions in append order, optionally for one effect id. */
  async listEvents(effectId?: string): Promise<EffectTransitionEvent[]> {
    return this.readEvents(effectId);
  }

  private readEvents(effectId?: string): EffectTransitionEvent[] {
    const rows =
      effectId === undefined
        ? this.db.prepare("SELECT * FROM relay_effect_events ORDER BY seq").all()
        : this.db.prepare("SELECT * FROM relay_effect_events WHERE effect_id = ? ORDER BY seq").all(effectId);
    return (rows as unknown as EventRow[]).map(toEvent);
  }

  private readRecords(key?: string): EffectRecord[] {
    const rows =
      key === undefined
        ? this.db.prepare("SELECT * FROM relay_effects ORDER BY created_at, id").all()
        : this.db.prepare("SELECT * FROM relay_effects WHERE key = ?").all(key);
    return (rows as unknown as EffectRow[]).map(toRecord);
  }

  /**
   * Read-only: latest-state row plus its observed transitions. Coverage is
   * derived from what exists, never inferred: `observed` when the chain
   * starts at the insert, `partial` when it starts mid-life (legacy row
   * transitioned after the event table existed), `unavailable` when empty.
   * Rows and events come from one snapshot so the pair is always coherent.
   */
  async listHistory(key?: string): Promise<EffectHistory[]> {
    const { records, events } = this.snapshot(() => ({
      records: this.readRecords(key),
      events: this.readEvents(),
    }));
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
    return this.readRecords();
  }
}

// ---------------------------------------------------------------------------
// Read-only evidence access (status export).
//
// `SqliteEffectJournal.open` is a writer path: it creates the directory and
// file, switches to WAL, creates/migrates schema and may VACUUM. Exporters
// must never do any of that to a journal they did not create, so this reader
// opens the file with SQLITE_OPEN_READONLY via `readOnly: true` — any write
// attempt (DDL, DML, migrating pragma) fails instead of mutating the input —
// and reads both tables inside one deferred transaction so rows and events
// always come from the same committed snapshot.
//
// Missing files are never created. A database without `relay_effects` is not
// a Relay journal and is rejected rather than treated as empty. Optional
// columns absent in legacy schemas (e.g. `intent_json`) read as NULL; a
// missing `relay_effect_events` table simply yields `unavailable` history —
// nothing is backfilled or inferred.
// ---------------------------------------------------------------------------

const REQUIRED_EFFECT_COLUMNS = [
  "id",
  "key",
  "kind",
  "request_hash",
  "replay",
  "status",
  "created_at",
  "updated_at",
] as const;
const OPTIONAL_EFFECT_COLUMNS = [
  "intent_json",
  "remote_ref",
  "result_json",
  "reason",
  "submitted_at",
  "settled_at",
] as const;
const REQUIRED_EVENT_COLUMNS = ["seq", "effect_id", "key", "kind", "from_status", "to_status", "cause", "at"] as const;

export class SqliteEffectJournalReader implements EffectHistoryReader {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly effectSelect: string;
  private readonly eventSelect: string | undefined;

  private constructor(
    db: import("node:sqlite").DatabaseSync,
    effectSelect: string,
    eventSelect: string | undefined,
  ) {
    this.db = db;
    this.effectSelect = effectSelect;
    this.eventSelect = eventSelect;
  }

  /**
   * Open an existing journal read-only. Throws when the path is missing, not
   * a file, not SQLite, or lacks the `relay_effects` shape — the caller maps
   * that to an explicit "journal unavailable" report. Never creates the
   * file, directories, schema, or runs migrations.
   */
  static async open(options: SqliteEffectJournalOptions): Promise<SqliteEffectJournalReader> {
    const info = await stat(options.path).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      throw new Error(`effect journal not found at ${options.path}`);
    }
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(options.path, { readOnly: true });
    try {
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relay_effects', 'relay_effect_events')")
            .all() as unknown as { name: string }[]
        ).map((t) => t.name),
      );
      if (!tables.has("relay_effects")) {
        throw new Error(`${options.path} is not a Relay effect journal (relay_effects table absent)`);
      }
      const effectColumns = columnNames(db, "relay_effects");
      for (const column of REQUIRED_EFFECT_COLUMNS) {
        if (!effectColumns.has(column)) {
          throw new Error(`relay_effects schema at ${options.path} is missing required column ${column}`);
        }
      }
      const effectSelect = `SELECT ${selectList(REQUIRED_EFFECT_COLUMNS, OPTIONAL_EFFECT_COLUMNS, effectColumns)} FROM relay_effects`;
      let eventSelect: string | undefined;
      if (tables.has("relay_effect_events")) {
        const eventColumns = columnNames(db, "relay_effect_events");
        if (REQUIRED_EVENT_COLUMNS.every((column) => eventColumns.has(column))) {
          // Extra legacy columns (reason, remote_ref) are never selected.
          eventSelect = `SELECT ${REQUIRED_EVENT_COLUMNS.join(", ")} FROM relay_effect_events`;
        }
      }
      return new SqliteEffectJournalReader(db, effectSelect, eventSelect);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private snapshot<T>(work: () => T): T {
    this.db.exec("BEGIN DEFERRED");
    try {
      return work();
    } finally {
      this.db.exec("COMMIT");
    }
  }

  private readRecords(key?: string): EffectRecord[] {
    const rows =
      key === undefined
        ? this.db.prepare(`${this.effectSelect} ORDER BY created_at, id`).all()
        : this.db.prepare(`${this.effectSelect} WHERE key = ?`).all(key);
    return (rows as unknown as EffectRow[]).map(toRecord);
  }

  private readEvents(effectId?: string): EffectTransitionEvent[] {
    if (this.eventSelect === undefined) return [];
    const rows =
      effectId === undefined
        ? this.db.prepare(`${this.eventSelect} ORDER BY seq`).all()
        : this.db.prepare(`${this.eventSelect} WHERE effect_id = ? ORDER BY seq`).all(effectId);
    return (rows as unknown as EventRow[]).map(toEvent);
  }

  /** Same coverage semantics as the writable journal: observed / partial / unavailable, never inferred. */
  async listHistory(key?: string): Promise<EffectHistory[]> {
    const { records, events } = this.snapshot(() => ({
      records: this.readRecords(key),
      events: this.readEvents(),
    }));
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

  async listEvents(effectId?: string): Promise<EffectTransitionEvent[]> {
    return this.snapshot(() => this.readEvents(effectId));
  }

  async list(): Promise<EffectRecord[]> {
    return this.snapshot(() => this.readRecords());
  }
}

function columnNames(db: import("node:sqlite").DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as unknown as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}

function selectList(
  required: readonly string[],
  optional: readonly string[],
  present: ReadonlySet<string>,
): string {
  const missingOptional = optional.filter((c) => !present.has(c));
  const selected = [...required, ...optional.filter((c) => present.has(c))];
  return [...selected, ...missingOptional.map((c) => `NULL AS ${c}`)].join(", ");
}
