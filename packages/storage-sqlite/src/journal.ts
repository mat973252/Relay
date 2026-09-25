/**
 * @relay/storage-sqlite — durable effect journal (M1).
 *
 * One row per semantic key. Commits are synchronous through `node:sqlite`
 * with WAL + synchronous=FULL so a SIGKILL between statements never loses a
 * committed status transition. This is Relay-owned state; it is NOT a Pi
 * session store.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EffectJournal, EffectRecord } from "@relay/core";

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
`;

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

export class SqliteEffectJournal implements EffectJournal {
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

  /** Capsule import path: atomically replaces the whole journal content. */
  async replaceAll(records: EffectRecord[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM relay_effects");
      for (const record of records) {
        this.db
          .prepare(
            `INSERT INTO relay_effects
               (id, key, kind, request_hash, intent_json, replay, status, remote_ref, result_json, reason,
                created_at, submitted_at, settled_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async insertPrepared(record: EffectRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relay_effects
           (id, key, kind, request_hash, intent_json, replay, status, remote_ref, result_json, reason,
            created_at, submitted_at, settled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', NULL, NULL, NULL, ?, NULL, NULL, ?)`,
      )
      .run(record.id, record.key, record.kind, record.requestHash, record.intentJson ?? null, record.replay, record.createdAt, record.updatedAt);
  }

  async markSubmitted(id: string, at: number): Promise<void> {
    const result = this.db
      .prepare("UPDATE relay_effects SET status = 'SUBMITTED', submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'PREPARED'")
      .run(at, at, id);
    if (result.changes !== 1) throw new Error(`invalid effect transition to SUBMITTED: ${id}`);
  }

  async markConfirmed(
    id: string,
    patch: { remoteRef: string | undefined; resultJson: string | undefined; at: number },
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE relay_effects
         SET status = 'CONFIRMED', remote_ref = ?, result_json = ?, settled_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')`,
      )
      .run(patch.remoteRef ?? null, patch.resultJson ?? null, patch.at, patch.at, id);
    if (result.changes !== 1) throw new Error(`invalid effect transition to CONFIRMED: ${id}`);
  }

  async markFailed(id: string, reason: string, at: number): Promise<void> {
    const result = this.db
      .prepare("UPDATE relay_effects SET status = 'FAILED', reason = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')")
      .run(reason, at, at, id);
    if (result.changes !== 1) throw new Error(`invalid effect transition to FAILED: ${id}`);
  }

  async markUnknown(id: string, reason: string, at: number): Promise<void> {
    const result = this.db
      .prepare("UPDATE relay_effects SET status = 'UNKNOWN', reason = ?, updated_at = ? WHERE id = ? AND status IN ('SUBMITTED', 'UNKNOWN')")
      .run(reason, at, id);
    if (result.changes !== 1) throw new Error(`invalid effect transition to UNKNOWN: ${id}`);
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
