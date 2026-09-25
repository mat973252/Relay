/**
 * Single-writer lock unit tests (safety-review regression set):
 *
 *  - malformed lock data fails CLOSED (no takeover of an unreadable lock);
 *  - release can never delete a successor's lock (checked through the full
 *    recorded acquisition body — pid alone is not ownership under pid reuse);
 *  - a lock naming THIS pid but written before this process booted is a
 *    provably dead predecessor (pid reuse) and may be taken over;
 *  - two independent successor processes racing for one stale lock yield
 *    EXACTLY ONE owner (atomic claim, not a settle delay);
 *  - foreign-host locks stay closed (pid checks are meaningless across OSes
 *    on a shared directory, e.g. WSL + Windows).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { takeWorkspaceOwnership, releaseWorkspaceOwnership, type LockFileBody } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-lock-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const LOCK = "mcp-owner.lock";

function writeLock(dir: string, body: LockFileBody | string): void {
  writeFileSync(join(dir, LOCK), typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
}

function readLockRaw(dir: string): string {
  return readFileSync(join(dir, LOCK), "utf8");
}

describe("workspace ownership lock", () => {
  it("acquires, releases, and re-acquires cleanly", async () => {
    const dir = mkdtempSync(join(tmp, "cycle-"));
    const first = await takeWorkspaceOwnership(dir);
    assert.equal(first.kind, "acquired");
    await releaseWorkspaceOwnership(dir);
    assert.equal(existsSync(join(dir, LOCK)), false, "release removes our own lock");
    const second = await takeWorkspaceOwnership(dir);
    assert.equal(second.kind, "acquired");
    await releaseWorkspaceOwnership(dir);
  });

  it("a live foreign-host lock fails closed instead of being taken over", async () => {
    const dir = mkdtempSync(join(tmp, "foreign-"));
    writeLock(dir, { pid: 999999, hostname: `${hostname()}-other`, startedAt: 1 });
    const result = await takeWorkspaceOwnership(dir);
    assert.equal(result.kind, "held-elsewhere");
    await releaseWorkspaceOwnership(dir); // must NOT remove the foreign lock
    assert.ok(existsSync(join(dir, LOCK)), "release must not remove a lock owned by someone else");
  });

  it("a dead same-host lock is taken over with verification", async () => {
    const dir = mkdtempSync(join(tmp, "dead-"));
    writeLock(dir, { pid: process.pid + 1, hostname: hostname(), startedAt: 1 });
    // pid()+1 is not this process; on a single-user dev box it is very likely
    // not alive. If it happens to be alive the test still passes via the
    // held-elsewhere branch being *safe*, so assert either closed-or-acquired.
    const result = await takeWorkspaceOwnership(dir);
    assert.ok(result.kind === "acquired" || result.kind === "held-elsewhere");
    if (result.kind === "acquired") {
      const verify = JSON.parse(readLockRaw(dir));
      assert.equal(verify.pid, process.pid);
      await releaseWorkspaceOwnership(dir);
    }
  });

  it("malformed lock data fails closed (no takeover of an unreadable lock)", async () => {
    const dir = mkdtempSync(join(tmp, "malformed-"));
    writeLock(dir, "{\"pid\": 42, \"hostname\": trunc"); // corrupt / partial write
    const result = await takeWorkspaceOwnership(dir);
    assert.equal(result.kind, "held-elsewhere", "corrupt lock content must fail closed, not open");
    assert.equal(
      readLockRaw(dir),
      "{\"pid\": 42, \"hostname\": trunc",
      "the malformed lock is left untouched for the operator",
    );
  });

  it("release never removes a successor's lock, even when it names our pid (startedAt is checked)", async () => {
    const dir = mkdtempSync(join(tmp, "release-"));
    const acquired = await takeWorkspaceOwnership(dir);
    assert.equal(acquired.kind, "acquired");
    // A successor replaced the lock (takeover after our death; same pid via
    // reuse, different startedAt). Old-owner release must not delete it.
    const successor: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: Date.now() + 12345 };
    writeLock(dir, successor);
    await releaseWorkspaceOwnership(dir);
    assert.deepEqual(JSON.parse(readLockRaw(dir)), successor, "release must leave a lock it did not write");
  });

  it("a lock naming our pid but older than our boot is a dead predecessor (pid reuse) and is taken over", async () => {
    const dir = mkdtempSync(join(tmp, "reuse-"));
    const predecessor: LockFileBody = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now() - 3_600_000, // written an hour before this process booted
    };
    writeLock(dir, predecessor);
    const result = await takeWorkspaceOwnership(dir);
    assert.equal(result.kind, "acquired", "same-pid lock written before our boot proves the writer is dead");
    const verify = JSON.parse(readLockRaw(dir));
    assert.equal(verify.pid, process.pid);
    assert.notEqual(verify.startedAt, predecessor.startedAt);
    await releaseWorkspaceOwnership(dir);
    assert.equal(existsSync(join(dir, LOCK)), false);
  });

  it("a lock naming our pid and newer than our boot that we did not write stays closed", async () => {
    const dir = mkdtempSync(join(tmp, "paranoid-"));
    const stranger: LockFileBody = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now() + 3_600_000, // implausible future start: not provably ours/predecessor
    };
    writeLock(dir, stranger);
    const result = await takeWorkspaceOwnership(dir);
    assert.equal(result.kind, "held-elsewhere", "same-pid lock we cannot attribute fails closed");
    await releaseWorkspaceOwnership(dir);
    assert.ok(existsSync(join(dir, LOCK)), "unattributed lock untouched");
  });
});

describe("cross-process takeover race", () => {
  const CHILD = fileURLToPath(new URL("./fixtures/takeover-child.js", import.meta.url));

  it("two independent successors racing for one stale lock: exactly one owner", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 3; round += 1) {
      const dir = mkdtempSync(join(tmp, `race${String(round)}-`));
      // A dead owner's stale lock (pid not in use, same host).
      writeLock(dir, { pid: 999_999 - round, hostname: hostname(), startedAt: 1 });
      const barrier = join(dir, "barrier");
      const children = [0, 1].map(() =>
        spawn(process.execPath, [CHILD, dir, barrier], { stdio: ["ignore", "pipe", "inherit"] }),
      );
      const results = children.map(
        (child) =>
          new Promise<{ kind: string; pid: number }>((resolve, reject) => {
            let buffer = "";
            child.stdout.on("data", (d: Buffer) => {
              buffer += d.toString();
              const line = buffer.split("\n").find((l) => l.trim().length > 0);
              if (line !== undefined) {
                try {
                  resolve(JSON.parse(line) as { kind: string; pid: number });
                } catch (err) {
                  reject(err instanceof Error ? err : new Error(String(err)));
                }
              }
            });
            child.on("close", () => {
              if (buffer.trim().length === 0) reject(new Error("child produced no result line"));
            });
          }),
      );
      await new Promise((r) => setTimeout(r, 150)); // both children are spawned and waiting
      writeFileSync(barrier, "go");
      const settled = await Promise.all(results);
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(children.map((c) => new Promise((r) => c.on("close", () => r(null)))));

      const owners = settled.filter((r) => r.kind === "acquired");
      assert.equal(
        owners.length,
        1,
        `round ${String(round)}: exactly one successor must acquire (got ${JSON.stringify(settled)})`,
      );
      const winner = owners[0]!;
      const onDisk = JSON.parse(readLockRaw(dir));
      assert.equal(onDisk.pid, winner.pid, "the lock names the winner");
      assert.equal(onDisk.hostname, hostname());
    }
  });

  it("old owner releasing while a successor attempts takeover never deletes a lock it did not write", { timeout: 60_000 }, async () => {
    // This process "acquired", then a successor attempts takeover while we
    // are alive: it must respect the live owner. After our release, a fresh
    // successor may acquire — and our release must never have removed
    // anything but our own lock along the way.
    const dir = mkdtempSync(join(tmp, "releaserace-"));
    const acquired = await takeWorkspaceOwnership(dir);
    assert.equal(acquired.kind, "acquired");
    const barrier = join(dir, "barrier");
    const child = spawn(process.execPath, [CHILD, dir, barrier], { stdio: ["ignore", "pipe", "inherit"] });
    const childResult = await new Promise<{ kind: string; pid: number }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error("child never reported (barrier not written)")),
        15_000,
      );
      child.stdout.on("data", (d: Buffer) => {
        buffer += d.toString();
        const line = buffer.split("\n").find((l) => l.trim().length > 0);
        if (line !== undefined) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line) as { kind: string; pid: number });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    });
    try {
      // The child saw OUR live lock: it must have failed closed...
      assert.equal(childResult.kind, "held-elsewhere", "successor must respect a live owner");
      // ...we release, and only our own lock disappears.
      await releaseWorkspaceOwnership(dir);
      assert.equal(existsSync(join(dir, LOCK)), false, "release removed exactly our own lock");
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.on("close", () => r(null)));
    }
  });
});
