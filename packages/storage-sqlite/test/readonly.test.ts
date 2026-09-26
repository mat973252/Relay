/**
 * Read-only journal access (mat-console status export path).
 *
 * `SqliteEffectJournal.open` is a writer: it creates the directory and file,
 * switches to WAL, creates/migrates schema and may VACUUM. None of that is
 * acceptable for an exporter reading a journal it did not create, so
 * `SqliteEffectJournalReader` opens the file SQLITE_OPEN_READONLY: reads see
 * one committed snapshot, and any write attempt fails instead of mutating the
 * input. These tests pin the zero-mutation contract on real files.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EffectRecord, EffectTransitionEvent } from "@relay/core";
import { SqliteEffectJournal, SqliteEffectJournalReader } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-readonly-"));
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

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("SqliteEffectJournalReader", () => {
  it("missing journal path throws and creates no file or directory", async () => {
    const dir = join(tmp, "no-such-dir");
    const dbPath = join(dir, "storage.db");
    await assert.rejects(() => SqliteEffectJournalReader.open({ path: dbPath }), /not found/);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(dir), false);
  });

  it("reads the same history as the writable journal and leaves the file byte-identical", async () => {
    const dbPath = join(tmp, "populated.db");
    const writer = await SqliteEffectJournal.open({ path: dbPath });
    await writer.insertPrepared(prepared("r1", "ro/1", 1));
    await writer.markSubmitted("r1", 2);
    await writer.markUnknown("r1", "ambiguous", 3, "execute");
    await writer.insertPrepared(prepared("r2", "ro/2", 4));
    const expected = await writer.listHistory();
    writer.close();

    const before = sha256(dbPath);
    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    try {
      const histories = await reader.listHistory();
      assert.equal(histories.length, 2);
      const r1 = histories.find((h) => h.record.id === "r1");
      assert.ok(r1);
      assert.equal(r1.coverage, "observed");
      assert.equal(r1.record.status, "UNKNOWN");
      // The reader is an evidence projection: identity/status/timestamps and
      // events match the writer exactly; free-form columns stay NULL.
      const project = (list: typeof histories) =>
        list.map((h) => ({
          id: h.record.id,
          key: h.record.key,
          kind: h.record.kind,
          status: h.record.status,
          createdAt: h.record.createdAt,
          submittedAt: h.record.submittedAt,
          settledAt: h.record.settledAt,
          updatedAt: h.record.updatedAt,
          coverage: h.coverage,
          events: h.events,
        }));
      assert.deepEqual(project(histories), project(expected));
      // The writer recorded free-form text; the reader never selects it.
      const writerR1 = expected.find((h) => h.record.id === "r1");
      assert.equal(writerR1?.record.reason, "ambiguous");
      assert.equal(r1.record.reason, undefined, "free-form reason is never read");
      const filtered = await reader.listHistory("ro/2");
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0]?.record.status, "PREPARED");
    } finally {
      reader.close();
    }
    assert.equal(sha256(dbPath), before, "read-only export must not modify the journal file");
  });

  it("legacy database without the events table: records read, history unavailable, file untouched", async () => {
    const dbPath = join(tmp, "legacy-ro.db");
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

    const before = sha256(dbPath);
    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    try {
      const histories = await reader.listHistory();
      assert.equal(histories.length, 2);
      for (const h of histories) {
        assert.equal(h.coverage, "unavailable", "no invented transitions for legacy rows");
        assert.deepEqual(h.events, []);
      }
      assert.equal(histories.find((h) => h.record.key === "legacy/unknown")?.record.status, "UNKNOWN");
    } finally {
      reader.close();
    }
    assert.equal(sha256(dbPath), before);
    // No schema was added: still no events table.
    const check = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    check.close();
    assert.deepEqual(tables.map((t) => t.name), ["relay_effects"]);
  });

  it("legacy events table with free-form columns is read without migrating or selecting them", async () => {
    const dbPath = join(tmp, "legacy-events-ro.db");
    const sqlite = await import("node:sqlite");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE relay_effects (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
        intent_json TEXT, replay TEXT NOT NULL, status TEXT NOT NULL, remote_ref TEXT, result_json TEXT, reason TEXT,
        created_at INTEGER NOT NULL, submitted_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE relay_effect_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL REFERENCES relay_effects(id),
        key TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, cause TEXT NOT NULL,
        reason TEXT, remote_ref TEXT, at INTEGER NOT NULL
      );
      INSERT INTO relay_effects VALUES ('m1','mig/1','k','h',NULL,'never','UNKNOWN',NULL,NULL,'ambiguous: token=MARKER',1,2,NULL,3);
      INSERT INTO relay_effect_events VALUES (1,'m1','mig/1','k',NULL,'PREPARED','prepare',NULL,NULL,1);
      INSERT INTO relay_effect_events VALUES (2,'m1','mig/1','k','PREPARED','SUBMITTED','submit',NULL,NULL,2);
      INSERT INTO relay_effect_events VALUES (3,'m1','mig/1','k','SUBMITTED','UNKNOWN','execute','ambiguous: token=MARKER','ref-MARKER',3);
    `);
    raw.close();

    const before = sha256(dbPath);
    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    try {
      const [h] = await reader.listHistory("mig/1");
      assert.ok(h);
      assert.equal(h.coverage, "observed");
      assert.deepEqual(shape(h.events), [
        [undefined, "PREPARED", "prepare"],
        ["PREPARED", "SUBMITTED", "submit"],
        ["SUBMITTED", "UNKNOWN", "execute"],
      ]);
      // Free-form columns are never selected; the event type cannot carry them.
      assert.equal(JSON.stringify(h.events).includes("MARKER"), false);
    } finally {
      reader.close();
    }
    assert.equal(sha256(dbPath), before);
    // The migration that SqliteEffectJournal.open would run did NOT happen:
    // the dropped free-form columns are still present.
    const check = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const columns = (check.prepare("PRAGMA table_info(relay_effect_events)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    check.close();
    assert.ok(columns.includes("reason") && columns.includes("remote_ref"), "reader must not migrate");
  });

  it("corrupt or non-journal files are rejected without mutation", async () => {
    const garbage = join(tmp, "garbage.db");
    writeFileSync(garbage, "definitely not sqlite contents", "utf8");
    const garbageBefore = sha256(garbage);
    await assert.rejects(() => SqliteEffectJournalReader.open({ path: garbage }));
    assert.equal(sha256(garbage), garbageBefore);

    const notRelay = join(tmp, "not-relay.db");
    const sqlite = await import("node:sqlite");
    const other = new sqlite.DatabaseSync(notRelay);
    other.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
    other.close();
    const notRelayBefore = sha256(notRelay);
    await assert.rejects(() => SqliteEffectJournalReader.open({ path: notRelay }), /not a Relay effect journal/);
    assert.equal(sha256(notRelay), notRelayBefore);
  });

  it("malformed rows/events are dropped and counted; broken event chains lose coverage", async () => {
    const dbPath = join(tmp, "malformed-ro.db");
    const sqlite = await import("node:sqlite");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE relay_effects (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
        intent_json TEXT, replay TEXT NOT NULL, status TEXT NOT NULL, remote_ref TEXT, result_json TEXT, reason TEXT,
        created_at INTEGER NOT NULL, submitted_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE relay_effect_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL REFERENCES relay_effects(id),
        key TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, cause TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      INSERT INTO relay_effects VALUES ('ok-1','ok/1','k','h',NULL,'never','UNKNOWN',NULL,NULL,'r',1,2,NULL,3);
      INSERT INTO relay_effect_events VALUES (1,'ok-1','ok/1','k',NULL,'PREPARED','prepare',1);
      INSERT INTO relay_effect_events VALUES (2,'ok-1','ok/1','k','PREPARED','SUBMITTED','submit',2);
      INSERT INTO relay_effect_events VALUES (3,'ok-1','ok/1','k','SUBMITTED','SIDWAYS','execute',3);
      INSERT INTO relay_effects VALUES ('bad-1','bad/1','k','h',NULL,'never','NOPE',NULL,NULL,NULL,1,NULL,NULL,1);
      INSERT INTO relay_effects VALUES ('bad-2','bad/2','k','h',NULL,'never','CONFIRMED',NULL,NULL,NULL,'text-time',NULL,NULL,1);
    `);
    raw.close();
    const before = sha256(dbPath);

    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    try {
      const result = await reader.readJournal();
      assert.equal(result.malformedRows, 3, "2 bad rows + 1 bad event");
      assert.equal(result.histories.length, 1, "malformed rows never sampled");
      const [h] = result.histories;
      assert.ok(h);
      assert.equal(h.record.id, "ok-1");
      // A malformed event in the chain makes the chain untrusted -> unavailable.
      assert.equal(h.coverage, "unavailable");
      assert.equal(h.events.length, 2);
    } finally {
      reader.close();
    }
    assert.equal(sha256(dbPath), before);
  });

  it("returns a coherent row/event snapshot under an interleaved writer", async () => {
    const dbPath = join(tmp, "snapshot-ro.db");
    const seed = await SqliteEffectJournal.open({ path: dbPath });
    seed.close();
    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    const writer = await SqliteEffectJournal.open({ path: dbPath });
    try {
      await writer.insertPrepared(prepared("s1", "snap/1", 1));
      await writer.markSubmitted("s1", 2);

      // node:sqlite is synchronous: the whole deferred snapshot runs before
      // listHistory's promise is returned, so the writer commits below can
      // only land strictly after or strictly before it — never inside it.
      const pending = reader.listHistory();
      await writer.markConfirmed("s1", { remoteRef: "r-1", resultJson: undefined, at: 3, cause: "execute" });
      await writer.insertPrepared(prepared("s2", "snap/2", 4));

      const histories = await pending;
      for (const h of histories) {
        assert.equal(h.events.at(-1)?.toStatus, h.record.status, `row/event disagree for ${h.record.id}`);
      }
      const s1 = histories.find((h) => h.record.id === "s1");
      assert.ok(s1);
      assert.equal(s1.record.status, "SUBMITTED");
      assert.equal(histories.some((h) => h.record.id === "s2"), false);

      const after = await reader.listHistory();
      assert.equal(after.find((h) => h.record.id === "s1")?.record.status, "CONFIRMED");
      assert.equal(after.find((h) => h.record.id === "s2")?.coverage, "observed");
    } finally {
      reader.close();
      writer.close();
    }
  });

  it("WAL scratch sidecars are the only directory change; reopen stays stable", async () => {
    const dir = join(tmp, "wal-sidecar");
    const dbPath = join(dir, "storage.db");
    const writer = await SqliteEffectJournal.open({ path: dbPath });
    await writer.insertPrepared(prepared("w1", "w/1", 1));
    writer.close();

    const entriesBefore = new Set(readdirSync(dir));
    const before = sha256(dbPath);
    const reader = await SqliteEffectJournalReader.open({ path: dbPath });
    const first = await reader.listHistory();
    reader.close();
    const entriesAfter = readdirSync(dir);
    assert.equal(sha256(dbPath), before);
    // SQLite materializes <db>-shm/-wal for a WAL read; nothing else may appear.
    for (const entry of entriesAfter) {
      assert.ok(entriesBefore.has(entry) || /^storage\.db-(shm|wal)$/.test(entry), `unexpected new file ${entry}`);
    }
    assert.equal(first.length, 1);
  });
});
