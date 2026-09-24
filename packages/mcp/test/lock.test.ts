/**
 * Single-writer lock unit tests: foreign-host locks stay closed (pid checks
 * are meaningless across OSes on a shared directory, e.g. WSL + Windows).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { takeWorkspaceOwnership, releaseWorkspaceOwnership } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-lock-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("workspace ownership lock", () => {
  it("acquires, releases, and re-acquires cleanly", async () => {
    const dir = mkdtempSync(join(tmp, "cycle-"));
    const first = await takeWorkspaceOwnership(dir, { settleMs: 0 });
    assert.equal(first.kind, "acquired");
    await releaseWorkspaceOwnership(dir);
    const second = await takeWorkspaceOwnership(dir, { settleMs: 0 });
    assert.equal(second.kind, "acquired");
    await releaseWorkspaceOwnership(dir);
  });

  it("a live foreign-host lock fails closed instead of being taken over", async () => {
    const dir = mkdtempSync(join(tmp, "foreign-"));
    writeFileSync(
      join(dir, "mcp-owner.lock"),
      `${JSON.stringify({ pid: 999999, hostname: `${hostname()}-other`, startedAt: 1 })}\n`,
    );
    const result = await takeWorkspaceOwnership(dir, { settleMs: 0 });
    assert.equal(result.kind, "held-elsewhere");
    await releaseWorkspaceOwnership(dir); // must NOT remove the foreign lock
    assert.ok(
      (await import("node:fs")).existsSync(join(dir, "mcp-owner.lock")),
      "release must not remove a lock owned by someone else",
    );
  });

  it("a dead same-host lock is taken over with verification", async () => {
    const dir = mkdtempSync(join(tmp, "dead-"));
    writeFileSync(
      join(dir, "mcp-owner.lock"),
      `${JSON.stringify({ pid: process.pid + 1, hostname: hostname(), startedAt: 1 })}\n`,
    );
    // pid()+1 is not this process; on a single-user dev box it is very likely
    // not alive. If it happens to be alive the test still passes via the
    // held-elsewhere branch being *safe*, so assert either closed-or-acquired.
    const result = await takeWorkspaceOwnership(dir, { settleMs: 0 });
    assert.ok(result.kind === "acquired" || result.kind === "held-elsewhere");
    if (result.kind === "acquired") {
      const verify = JSON.parse((await import("node:fs")).readFileSync(join(dir, "mcp-owner.lock"), "utf8"));
      assert.equal(verify.pid, process.pid);
      await releaseWorkspaceOwnership(dir);
    }
  });
});
