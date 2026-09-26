/**
 * `relay status` — emits mat-console.status/1 from a read-only journal open.
 *
 * Key invariants: the command never creates or mutates the journal, never
 * exports effect keys/ids/reasons/refs/payloads, keeps health scoped to what
 * the local journal actually shows, and always emits a contract-valid
 * document — including when the journal is missing or unreadable.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { SqliteEffectJournal } from "@relay/storage-sqlite";

const cliJs = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET_VALUE = "relay-status-fake-secret-value";
const MARKER = "MARKER-NOT-EXPORTED";

let tmp = "";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-status-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string = tmp) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, RELAY_TEST_STATUS_SECRET: SECRET_VALUE },
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Doc {
  contract?: unknown;
  generated_at?: unknown;
  ttl_seconds?: unknown;
  project?: { id?: unknown; name?: unknown };
  health?: { state?: unknown; summary?: unknown };
  attention?: { id?: unknown; severity?: unknown; title?: unknown }[];
  progress?: unknown;
  milestones?: unknown;
  runs?: unknown;
}

function parseDoc(result: ReturnType<typeof runCli>): Doc {
  return JSON.parse((result.stdout ?? "").trim()) as Doc;
}

/** Contract shape mirrored from the consumer validator (verified separately against mat-console). */
function assertDocumentShape(doc: Doc): void {
  assert.equal(doc.contract, "mat-console.status/1");
  assert.match(String(doc.generated_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.ok(typeof doc.project?.id === "string" && doc.project.id !== "");
  assert.ok(typeof doc.project?.name === "string" && doc.project.name !== "");
  if (doc.health !== undefined) {
    assert.ok(["ok", "attention", "degraded", "unknown"].includes(String(doc.health.state)));
  }
  for (const key of Object.keys(doc)) {
    assert.doesNotMatch(key, /(secret|token|passw(?:or)?d|credential|api[_-]?key|bearer|private[_-]?key)/i);
  }
}

async function seedJournal(dir: string): Promise<string> {
  const dbPath = join(dir, "storage.db");
  const journal = await SqliteEffectJournal.open({ path: dbPath });
  try {
    const rec = (id: string, key: string, at: number) => ({
      id: `${id}-${MARKER}`,
      key: `${key}-${MARKER}`,
      kind: `kind-${MARKER}`,
      requestHash: `h-${id}`,
      intentJson: `{"intent":"${MARKER}"}`,
      replay: "never" as const,
      status: "PREPARED" as const,
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: at,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: at,
    });
    await journal.insertPrepared(rec("e1", "op/confirmed", 1_000));
    await journal.markSubmitted(`e1-${MARKER}`, 2_000);
    await journal.markConfirmed(`e1-${MARKER}`, {
      remoteRef: `remote-${MARKER}`,
      resultJson: `{"result":"${MARKER}"}`,
      at: 3_000,
      cause: "execute",
    });
    await journal.insertPrepared(rec("e2", "op/unknown", 4_000));
    await journal.markSubmitted(`e2-${MARKER}`, 5_000);
    await journal.markUnknown(`e2-${MARKER}`, `ambiguous ${MARKER}`, 6_000, "execute");
    await journal.insertPrepared(rec("e3", "op/prepared", 7_000));
  } finally {
    journal.close();
  }
  return dbPath;
}

describe("relay status", () => {
  it("emits a contract document with aggregate counts and no journal internals", async () => {
    const dir = join(tmp, "populated");
    const dbPath = await seedJournal(dir);
    const before = sha256(dbPath);

    const result = runCli(["status", "--storage", dbPath]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    const doc = parseDoc(result);
    assertDocumentShape(doc);
    assert.equal(doc.health?.state, "attention");
    const summary = String(doc.health?.summary);
    assert.match(summary, /3 effects/);
    assert.match(summary, /1 confirmed/);
    assert.match(summary, /1 unknown/);
    assert.match(summary, /1 prepared/);
    assert.match(summary, /observed for 3 of 3/);
    assert.match(summary, /latest journal write/);

    const attention = doc.attention ?? [];
    assert.ok(attention.some((a) => a.id === "unresolved-unknown-effects"));
    // Nothing identifiable or free-form leaves the journal.
    assert.ok(!output.includes(MARKER), "journal internals leaked into status output");
    assert.ok(!output.includes(SECRET_VALUE), "environment value leaked into status output");
    assert.equal(doc.progress, undefined);
    assert.equal(doc.milestones, undefined);
    assert.equal(doc.runs, undefined);
    assert.equal(sha256(dbPath), before, "journal file must be byte-identical after export");
  });

  it("empty journal: health unknown, no fabricated content, file unchanged", async () => {
    const dir = join(tmp, "empty");
    const dbPath = join(dir, "storage.db");
    const journal = await SqliteEffectJournal.open({ path: dbPath });
    journal.close();
    const before = sha256(dbPath);

    const result = runCli(["status", "--storage", dbPath]);
    assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    const doc = parseDoc(result);
    assertDocumentShape(doc);
    assert.equal(doc.health?.state, "unknown");
    assert.match(String(doc.health?.summary), /no effect records/);
    assert.equal(doc.attention, undefined);
    assert.equal(sha256(dbPath), before);
  });

  it("missing journal: valid document, exit 1, nothing created on disk", () => {
    const dir = join(tmp, "missing");
    const dbPath = join(dir, "storage.db");
    const result = runCli(["status", "--storage", dbPath]);
    assert.equal(result.status, 1);
    const doc = parseDoc(result);
    assertDocumentShape(doc);
    assert.equal(doc.health?.state, "unknown");
    assert.equal(doc.attention?.[0]?.id, "journal-unavailable");
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(dir), false);
  });

  it("legacy schema without the events table: coverage gap surfaced, file untouched", async () => {
    const dir = join(tmp, "legacy");
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "storage.db");
    const sqlite = await import("node:sqlite");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE relay_effects (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
        replay TEXT NOT NULL, status TEXT NOT NULL, remote_ref TEXT, result_json TEXT, reason TEXT,
        created_at INTEGER NOT NULL, submitted_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL
      );
      INSERT INTO relay_effects VALUES ('l1-${MARKER}','legacy/a-${MARKER}','k','h','never','UNKNOWN',NULL,NULL,'reason-${MARKER}',1,2,NULL,3);
    `);
    raw.close();
    const before = sha256(dbPath);

    const result = runCli(["status", "--storage", dbPath]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    const doc = parseDoc(result);
    assertDocumentShape(doc);
    assert.equal(doc.health?.state, "attention");
    assert.ok((doc.attention ?? []).some((a) => a.id === "history-coverage-gap"));
    assert.ok((doc.attention ?? []).some((a) => a.id === "unresolved-unknown-effects"));
    assert.ok(!output.includes(MARKER));
    assert.equal(sha256(dbPath), before);
    // No migration ran: the events table still does not exist.
    const check = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    check.close();
    assert.deepEqual(tables.map((t) => t.name), ["relay_effects"]);
  });

  it("corrupt file: valid unavailable document, exit 1, bytes unchanged", () => {
    const dir = join(tmp, "corrupt");
    const dbPath = join(dir, "storage.db");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dbPath, "not sqlite at all", "utf8");
    const before = sha256(dbPath);
    const result = runCli(["status", "--storage", dbPath]);
    assert.equal(result.status, 1);
    const doc = parseDoc(result);
    assertDocumentShape(doc);
    assert.equal(doc.attention?.[0]?.id, "journal-unavailable");
    assert.equal(sha256(dbPath), before);
  });

  it("--output writes the document to a file and keeps stdout clean of payload", async () => {
    const dir = join(tmp, "out");
    const dbPath = await seedJournal(dir);
    const outPath = join(dir, "relay-status.json");
    const before = sha256(dbPath);
    const result = runCli(["status", "--storage", dbPath, "--output", outPath]);
    assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    assert.equal(existsSync(outPath), true);
    const doc = JSON.parse(readFileSync(outPath, "utf8")) as Doc;
    assertDocumentShape(doc);
    assert.ok(!readFileSync(outPath, "utf8").includes(MARKER));
    assert.equal(sha256(dbPath), before);
  });

  it("usage errors exit 64 and emit no document", () => {
    const result = runCli(["status", "--bogus"]);
    assert.equal(result.status, 64);
    assert.throws(() => parseDoc(result));
  });
});
