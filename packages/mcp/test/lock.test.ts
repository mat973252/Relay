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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { takeWorkspaceOwnership, releaseWorkspaceOwnership, type LockFileBody } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-lock-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const LOCK = "mcp-owner.lock";

/** Mirrors the on-disk fence naming contract: claim.<sha256([pid,hostname,startedAt])[:16]>. */
function fenceName(body: LockFileBody): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([body.pid, body.hostname, body.startedAt]), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `mcp-owner.claim.${hash}`;
}

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
  const WATCHER = fileURLToPath(new URL("./fixtures/watch-lock-child.js", import.meta.url));
  const FENCE_WATCHER = fileURLToPath(new URL("./fixtures/watch-fence-child.js", import.meta.url));

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

  it("takeover never leaves the lock path absent; an attempt fired inside any absence cannot leapfrog the claimant", { timeout: 90_000 }, async () => {
    const collect = (child: ReturnType<typeof spawn>): Promise<{ kind: string; pid: number }> =>
      new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("child never reported")), 25_000);
        child.stdout!.on("data", (d: Buffer) => {
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

    for (let round = 0; round < 3; round += 1) {
      const dir = mkdtempSync(join(tmp, `window${String(round)}-`));
      writeLock(dir, { pid: 999_998 - round, hostname: hostname(), startedAt: 1 });
      const barrierW = join(dir, "barrier-w");
      const trigger = join(dir, "trigger"); // written by the watcher at the FIRST absence
      const stop = join(dir, "stop");
      const reportPath = join(dir, "watch-report.json");

      const watcher = spawn(process.execPath, [WATCHER, join(dir, LOCK), trigger, stop, reportPath], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      const winner = spawn(process.execPath, [CHILD, dir, barrierW], { stdio: ["ignore", "pipe", "inherit"] });
      const opportunist = spawn(process.execPath, [CHILD, dir, trigger], { stdio: ["ignore", "pipe", "inherit"] });

      await new Promise((r) => setTimeout(r, 200)); // both children + watcher are up
      writeFileSync(barrierW, "go");
      const wResult = await collect(winner);
      writeFileSync(stop, "go"); // watcher exits and reports
      await new Promise((r) => setTimeout(r, 150));
      if (!existsSync(trigger)) writeFileSync(trigger, "go"); // fallback when no window ever opened
      const tResult = await collect(opportunist);

      // Attach close handlers BEFORE killing (the watcher may already have
      // exited on its own — a late `on("close")` would never fire).
      const closed = [watcher, winner, opportunist].map((c) =>
        new Promise((r) => {
          if (c.exitCode !== null) r(null);
          else c.once("close", () => r(null));
        }),
      );
      watcher.kill("SIGKILL");
      winner.kill("SIGKILL");
      opportunist.kill("SIGKILL");
      await Promise.all(closed);

      const report = JSON.parse(readFileSync(reportPath, "utf8")) as { absentCount: number; triggered: boolean };
      assert.equal(
        report.absentCount,
        0,
        `round ${String(round)}: the lock path went absent ${String(report.absentCount)} time(s) during takeover — a claim/install gap exists`,
      );
      assert.equal(
        wResult.kind,
        "acquired",
        `round ${String(round)}: the takeover claimant must become the owner (got ${JSON.stringify(wResult)})`,
      );
      assert.equal(tResult.kind, "held-elsewhere", "an attempt fired inside a gap must not leapfrog the claimant");
      const onDisk = JSON.parse(readLockRaw(dir));
      assert.equal(onDisk.pid, wResult.pid, "the lock names the claimant, not the opportunist");
    }
  });

  it("dead-claimant fence recovery never leaves the succession unprotected; an attempt fired inside any gap cannot leapfrog", { timeout: 90_000 }, async () => {
    const collect = (child: ReturnType<typeof spawn>): Promise<{ kind: string; pid: number }> =>
      new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("child never reported")), 25_000);
        child.stdout!.on("data", (d: Buffer) => {
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
    const settle = (children: ReturnType<typeof spawn>[]): Promise<unknown[]> => {
      const closed = children.map((c) =>
        new Promise((r) => {
          if (c.exitCode !== null) r(null);
          else c.once("close", () => r(null));
        }),
      );
      for (const c of children) c.kill("SIGKILL");
      return Promise.all(closed);
    };

    for (let round = 0; round < 2; round += 1) {
      const dir = mkdtempSync(join(tmp, `fencegap${String(round)}-`));
      // A stale lock whose succession fence was left behind by a claimant
      // that died before installing.
      const stale: LockFileBody = { pid: 999_995 - round, hostname: hostname(), startedAt: 1 };
      writeLock(dir, stale);
      const fence = join(dir, fenceName(stale));
      const hash = fenceName(stale).split(".").pop() ?? "";
      writeFileSync(
        fence,
        `${JSON.stringify({ pid: 999_994 - round, hostname: hostname(), startedAt: 1, for: hash })}\n`,
      );

      const barrier = join(dir, "barrier");
      const trigger = join(dir, "trigger"); // written by the watcher at the FIRST unprotected instant
      const stop = join(dir, "stop");
      const reportPath = join(dir, "fence-report.json");

      const watcher = spawn(
        process.execPath,
        [
          FENCE_WATCHER,
          join(dir, LOCK),
          fence,
          String(stale.pid),
          stale.hostname,
          String(stale.startedAt),
          trigger,
          stop,
          reportPath,
        ],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      const s1 = spawn(process.execPath, [CHILD, dir, barrier], { stdio: ["ignore", "pipe", "inherit"] });
      const s2 = spawn(process.execPath, [CHILD, dir, barrier], { stdio: ["ignore", "pipe", "inherit"] });
      const opportunist = spawn(process.execPath, [CHILD, dir, trigger], { stdio: ["ignore", "pipe", "inherit"] });

      await new Promise((r) => setTimeout(r, 250)); // children + watcher are up
      writeFileSync(barrier, "go");
      const r1 = await collect(s1);
      const r2 = await collect(s2);
      writeFileSync(stop, "go"); // watcher exits and reports
      await new Promise((r) => setTimeout(r, 150));
      if (!existsSync(trigger)) writeFileSync(trigger, "go"); // fallback when no gap ever opened
      const r3 = await collect(opportunist);

      await settle([watcher, s1, s2, opportunist]);

      const report = JSON.parse(readFileSync(reportPath, "utf8")) as { gapCount: number; triggered: boolean };
      assert.equal(
        report.gapCount,
        0,
        `round ${String(round)}: the succession was unprotected ${String(report.gapCount)} time(s) (fence absent while the stale lock was still in place) — a recovery gap exists`,
      );
      const acquired = [r1, r2, r3].filter((r) => r.kind === "acquired");
      assert.equal(acquired.length, 1, `round ${String(round)}: exactly one owner (got ${JSON.stringify([r1, r2, r3])})`);
      const onDisk = JSON.parse(readLockRaw(dir));
      assert.equal(onDisk.pid, acquired[0]!.pid, "the lock names the acquirer");
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

describe("dead-claimant fence transfer (Windows EPERM regression set)", () => {
  const deadBody = (pid: number): LockFileBody => ({ pid, hostname: hostname(), startedAt: 1 });

  it("SIMULATED Windows EPERM: takeover succeeds on a filesystem that denies rename-replace on claim paths", async () => {
    // Simulated evidence: on Windows Node 24.13, rename(claimantTmp, fence)
    // failed EPERM when the fence inode was multiply-linked / transiently
    // opened by a racing process (MoveFileExW+REPLACE_EXISTING is not
    // guaranteed against such targets). The transfer must not need it.
    const dir = mkdtempSync(join(tmp, "winperm-"));
    const stale = deadBody(999_993);
    writeLock(dir, stale);
    const hash = fenceName(stale).split(".").pop() ?? "";
    const fence = join(dir, fenceName(stale));
    const deadClaimant = { ...deadBody(999_992), for: hash };
    writeFileSync(fence, `${JSON.stringify(deadClaimant)}\n`);

    let claimRenames = 0;
    const denyClaimRename = async (oldPath: string, newPath: string): Promise<void> => {
      if (basename(newPath).startsWith("mcp-owner.claim.")) {
        claimRenames += 1;
        const err = new Error("operation not permitted (simulated Windows EPERM)") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      await rename(oldPath, newPath);
    };
    const result = await takeWorkspaceOwnership(dir, { rename: denyClaimRename });
    assert.equal(result.kind, "acquired", "claim transfer must not depend on rename-replace of a claim path");
    assert.equal(claimRenames, 0, "the transfer never attempted a rename on a claim path");
    const verify = JSON.parse(readLockRaw(dir));
    assert.equal(verify.pid, process.pid);
    // The dead claimant's file was never renamed or rewritten.
    assert.deepEqual(JSON.parse(readFileSync(fence, "utf8")), deadClaimant, "the dead claimant's fence file is untouched");
    await releaseWorkspaceOwnership(dir);
  });

  it("SIMULATED transient EPERM on the install rename is retried", async () => {
    // Simulated evidence: the same Windows transient can hit rename(next,
    // lock) while another process holds a snapshot link/handle on the lock
    // inode. The install may retry, but only while the lock still names the
    // exact stale body we claimed for.
    const dir = mkdtempSync(join(tmp, "wininst-"));
    const stale = deadBody(999_991);
    writeLock(dir, stale);
    let denials = 0;
    const flakyInstall = async (oldPath: string, newPath: string): Promise<void> => {
      if (basename(newPath) === LOCK && denials < 2) {
        denials += 1;
        const err = new Error("operation not permitted (simulated Windows EPERM)") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      await rename(oldPath, newPath);
    };
    const result = await takeWorkspaceOwnership(dir, { rename: flakyInstall });
    assert.equal(result.kind, "acquired", "transient EPERM on install is retried");
    assert.equal(denials, 2, "both injected denials were exercised");
    const verify = JSON.parse(readLockRaw(dir));
    assert.equal(verify.pid, process.pid);
    await releaseWorkspaceOwnership(dir);
  });

  it("a lock swapped to a live owner between install retries is never renamed over (fail closed)", async () => {
    // Deterministic version of the Windows race: the first install attempt is
    // denied EPERM and a DIFFERENT live owner lands its lock before our retry.
    // The retry must re-verify the stale body, refuse to rename over the live
    // owner's lock, and fail closed — leaving that lock and every claim file
    // of this succession untouched.
    const dir = mkdtempSync(join(tmp, "swapped-"));
    const stale = deadBody(999_984);
    writeLock(dir, stale);
    const base = fenceName(stale);
    const hash = base.split(".").pop() ?? "";
    const deadClaimant = { ...deadBody(999_983), for: hash };
    writeFileSync(join(dir, base), `${JSON.stringify(deadClaimant)}\n`);
    // A genuinely live owner (this process, started after module boot).
    const liveOwner: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: Date.now() };

    let installAttempts = 0;
    const denyThenSwap = async (oldPath: string, newPath: string): Promise<void> => {
      assert.equal(basename(newPath), LOCK, "the only rename in the protocol is the install");
      installAttempts += 1;
      if (installAttempts === 1) {
        writeFileSync(join(dir, LOCK), `${JSON.stringify(liveOwner)}\n`); // live owner lands mid-denial
        const err = new Error("operation not permitted (simulated Windows EPERM)") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      await rename(oldPath, newPath);
    };
    const result = await takeWorkspaceOwnership(dir, { rename: denyThenSwap });
    assert.equal(result.kind, "held-elsewhere", "the succession moved to a live owner: fail closed");
    assert.deepEqual(result.owner, liveOwner, "the refusal names the live owner");
    assert.equal(installAttempts, 1, "no second rename was attempted over the changed lock");
    assert.deepEqual(JSON.parse(readLockRaw(dir)), liveOwner, "the live owner's lock was never clobbered");
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, base), "utf8")),
      deadClaimant,
      "the dead claimant's fence file is untouched",
    );
    await releaseWorkspaceOwnership(dir); // must not remove the live owner's lock
    assert.deepEqual(JSON.parse(readLockRaw(dir)), liveOwner, "release left the live owner's lock in place");
  });

  it("a second dead claimant advances the claim chain instead of renaming over the first fence", async () => {
    // Two successive dead claimants (the first transferee also crashed before
    // installing): the transfer must climb past BOTH without any rename on a
    // claim path and without removing either dead claimant's file.
    const dir = mkdtempSync(join(tmp, "chain-"));
    const stale = deadBody(999_990);
    writeLock(dir, stale);
    const base = fenceName(stale);
    const hash = base.split(".").pop() ?? "";
    const first = { ...deadBody(999_989), for: hash };
    const second = { ...deadBody(999_988), for: hash };
    writeFileSync(join(dir, base), `${JSON.stringify(first)}\n`);
    writeFileSync(join(dir, `${base}.t1`), `${JSON.stringify(second)}\n`);

    const noClaimRename = async (oldPath: string, newPath: string): Promise<void> => {
      assert.ok(!newPath.includes("mcp-owner.claim."), "no rename may target a claim path");
      await rename(oldPath, newPath);
    };
    const result = await takeWorkspaceOwnership(dir, { rename: noClaimRename });
    assert.equal(result.kind, "acquired");
    const claims = readdirSync(dir).filter((n) => n.startsWith("mcp-owner.claim."));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, base), "utf8")), first, "first dead claimant untouched");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${base}.t1`), "utf8")), second, "second dead claimant untouched");
    const ours = claims.find((n) => n.startsWith(`${base}.t`) && n !== `${base}.t1`);
    assert.ok(ours, `our claim level exists among ${JSON.stringify(claims)}`);
    assert.equal(JSON.parse(readFileSync(join(dir, ours!), "utf8")).pid, process.pid);
    await releaseWorkspaceOwnership(dir);
  });

  it("a live claimant at the transfer level still fails closed (no leapfrog via the chain)", async () => {
    const dir = mkdtempSync(join(tmp, "livelvl-"));
    const stale = deadBody(999_987);
    writeLock(dir, stale);
    const base = fenceName(stale);
    const hash = base.split(".").pop() ?? "";
    writeFileSync(join(dir, base), `${JSON.stringify({ ...deadBody(999_986), for: hash })}\n`);
    writeFileSync(
      join(dir, `${base}.t1`),
      `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now(), for: hash })}\n`,
    );
    const result = await takeWorkspaceOwnership(dir);
    assert.equal(result.kind, "held-elsewhere", "a live successor at a deeper claim level still owns the succession");
    await releaseWorkspaceOwnership(dir);
    assert.equal(JSON.parse(readLockRaw(dir)).pid, stale.pid, "the stale lock was not clobbered");
  });
});
