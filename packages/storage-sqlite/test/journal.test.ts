/**
 * M1 SQLite effect journal: status transitions, uniqueness, and durability
 * across close/reopen (process restart model). Real SIGKILL durability is
 * covered by crash-matrix.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SqliteEffectJournal } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-journal-"));
const dbPath = join(tmp, "storage.db");
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("SqliteEffectJournal", () => {
  it("persists records across close/reopen", async () => {
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    await journal.insertPrepared({
      id: "eff-1",
      key: "counter/increment:1",
      kind: "http-counter/increment",
      requestHash: "abc",
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: 1,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: 1,
    });
    await journal.markSubmitted("eff-1", 2);
    journal.close();

    const reopened = await SqliteEffectJournal.open({ path: dbPath });
    try {
      const record = await reopened.getByKey("counter/increment:1");
      assert.ok(record !== undefined);
      assert.equal(record.status, "SUBMITTED");
      assert.equal(record.requestHash, "abc");
      assert.equal(record.submittedAt, 2);
      assert.equal((await reopened.list()).length, 1);
    } finally {
      reopened.close();
    }
  });

  it("applies every status transition with timestamps and evidence", async () => {
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    try {
      await journal.insertPrepared({
        id: "eff-2",
        key: "counter/increment:2",
        kind: "http-counter/increment",
        requestHash: "def",
        replay: "never",
        status: "PREPARED",
        remoteRef: undefined,
        resultJson: undefined,
        reason: undefined,
        createdAt: 10,
        submittedAt: undefined,
        settledAt: undefined,
        updatedAt: 10,
      });
      await journal.markSubmitted("eff-2", 11);
      await journal.markUnknown("eff-2", "ambiguous: connection reset", 12);
      let record = await journal.get("eff-2");
      assert.ok(record !== undefined);
      assert.equal(record.status, "UNKNOWN");
      assert.equal(record.reason, "ambiguous: connection reset");
      assert.equal(record.settledAt, undefined);

      await journal.markConfirmed("eff-2", {
        remoteRef: "fx-9",
        resultJson: JSON.stringify({ value: 9 }),
        at: 13,
      });
      record = await journal.get("eff-2");
      assert.ok(record !== undefined);
      assert.equal(record.status, "CONFIRMED");
      assert.equal(record.remoteRef, "fx-9");
      assert.equal(record.settledAt, 13);

      await journal.markFailed("eff-2", "late failure", 14);
      record = await journal.get("eff-2");
      assert.ok(record !== undefined);
      assert.equal(record.status, "FAILED");
    } finally {
      journal.close();
    }
  });

  it("rejects a second row for the same semantic key", async () => {
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    try {
      await assert.rejects(
        () =>
          journal.insertPrepared({
            id: "eff-3",
            key: "counter/increment:1",
            kind: "http-counter/increment",
            requestHash: "abc",
            replay: "never",
            status: "PREPARED",
            remoteRef: undefined,
            resultJson: undefined,
            reason: undefined,
            createdAt: 20,
            submittedAt: undefined,
            settledAt: undefined,
            updatedAt: 20,
          }),
        /UNIQUE/,
      );
    } finally {
      journal.close();
    }
  });
});
