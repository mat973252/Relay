import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { probeSqliteStorage } from "../src/index.js";

let tmp = "";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-sqlite-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("probeSqliteStorage", () => {
  it("verifies a writable database path and is repeatable on the same file", async () => {
    const path = join(tmp, "relay", "storage.db");
    const first = await probeSqliteStorage({ path });
    assert.equal(first.status, "ok");
    assert.match(first.detail, /node:sqlite read\/write verified/);
    const second = await probeSqliteStorage({ path });
    assert.equal(second.status, "ok");
    assert.deepEqual(second, first);
  });

  it("reports fail for a path that is not a database", async () => {
    const path = join(tmp, "junk.txt");
    writeFileSync(path, "this is not a sqlite database", "utf8");
    const outcome = await probeSqliteStorage({ path });
    assert.equal(outcome.status, "fail");
    assert.ok(outcome.detail.length > 0);
  });

  it("reports fail when the path is a directory", async () => {
    const path = join(tmp, "adir");
    mkdirSync(path);
    const outcome = await probeSqliteStorage({ path });
    assert.equal(outcome.status, "fail");
    assert.ok(outcome.detail.length > 0);
  });
});
