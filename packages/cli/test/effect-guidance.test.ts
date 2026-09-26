import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import type { EffectHistory, EffectStatus } from "@relay/core";
import { explainEffects } from "../src/effect-guidance.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
test("explain is read-only, preserves ambiguous identity and omits payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-explain-"));
  const path = join(dir, "journal.db");
  try {
    const journal = await SqliteEffectJournal.open({ path });
    await journal.insertPrepared({ id: "e1", key: "export:order:1", kind: "mcp:export", requestHash: "secret-hash", intentJson: "secret-intent", replay: "never", status: "PREPARED", createdAt: 1, updatedAt: 1, remoteRef: undefined, resultJson: undefined, reason: undefined, submittedAt: undefined, settledAt: undefined });
    await journal.markSubmitted("e1", 2);
    await journal.markUnknown("e1", "secret-reason", 3, "execute");
    journal.close();
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    const result = spawnSync(process.execPath, [cli, "effects", "--explain", "--key", "export:order:1", "--storage", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /UNKNOWN/);
    assert.match(result.stdout, /do not resubmit/i);
    assert.match(result.stdout, /"operationId":"order:1"/);
    assert.doesNotMatch(result.stdout, /secret-/);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mtimeMs, mtime);
    // SQLite may create WAL coordination sidecars even for readOnly opens.
    assert.ok(readdirSync(dir).every((name) => ["journal.db", "journal.db-wal", "journal.db-shm"].includes(name)));
    const missing = join(dir, "missing.db");
    const absent = spawnSync(process.execPath, [cli, "effects", "--explain", "--storage", missing], { encoding: "utf8" });
    assert.equal(absent.status, 1);
    assert.equal(existsSync(missing), false);
    const unknownKey = spawnSync(process.execPath, [cli, "effects", "--explain", "--key", "not-recorded", "--storage", path], { encoding: "utf8" });
    assert.equal(unknownKey.status, 1);
    assert.match(unknownKey.stdout, /Absence is not permission/);
    const conflict = spawnSync(process.execPath, [cli, "effects", "--explain", "--json", "--storage", missing], { encoding: "utf8" });
    assert.equal(conflict.status, 64);
    assert.equal(existsSync(missing), false);
    writeFileSync(missing, "not sqlite");
    const corrupt = spawnSync(process.execPath, [cli, "effects", "--explain", "--storage", missing], { encoding: "utf8" });
    assert.equal(corrupt.status, 1);
    assert.equal(readFileSync(missing, "utf8"), "not sqlite");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("state guidance does not authorize replay or guess arbitrary MCP keys", () => {
  const history = (status: EffectStatus, kind = "custom", key = "export:order:1"): EffectHistory => ({
    record: { id: "id", key, kind, status, requestHash: "", replay: "never", createdAt: 1, updatedAt: 2, remoteRef: undefined, resultJson: undefined, reason: undefined, submittedAt: undefined, settledAt: undefined },
    events: [], coverage: "unavailable",
  });
  for (const status of ["UNKNOWN", "SUBMITTED"] as const) {
    const text = explainEffects([history(status)], 0);
    assert.match(text, /do not resubmit/);
    assert.doesNotMatch(text, /relay_reconcile_operation/);
  }
  assert.doesNotMatch(explainEffects([history("UNKNOWN", "mcp:other")], 0), /relay_reconcile_operation/);
  assert.doesNotMatch(explainEffects([history("UNKNOWN", "mcp:export", "export:")], 0), /relay_reconcile_operation/);
  assert.match(explainEffects([history("PREPARED")], 0), /Check the current owner/);
  assert.match(explainEffects([history("CONFIRMED")], 0), /do not repeat/);
  assert.match(explainEffects([history("FAILED")], 0), /does not authorize a retry/);
  assert.match(explainEffects([], 2), /event checks include other keys/);
  assert.match(explainEffects([], 0), /Absence is not permission/);
});
