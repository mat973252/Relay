/**
 * @relay/mcp — single-writer workspace ownership (fail-closed boundary).
 *
 * v0.1's effect runner assumes ONE active writer per workspace: an in-flight
 * PREPARED record doubles as the crash-continuation state, so a second
 * concurrent server could race the first across the execute window. This
 * lock makes that assumption explicit. Safety review redesign:
 *
 *   - acquiring an absent lock = atomic O_EXCL create;
 *   - a live lock whose pid is alive on the same host => REFUSE (fail closed);
 *   - a lock whose pid is dead => takeover via an ATOMIC CLAIM: exactly one
 *     successor wins a `rename(lock -> unique tombstone)`; the loser's rename
 *     fails with ENOENT and it re-reads the winner's live lock and stays
 *     closed. The claim is then verified against the stale body observed
 *     before the rename, so a live owner's replacement lock can never be
 *     stolen silently. No settle delay is involved — the claim is the fence;
 *   - PID REUSE: a lock naming THIS pid that this process did not write is
 *     attributable through `startedAt`: written before this module loaded =>
 *     the writer is provably dead (pids are unique among live processes) =>
 *     takeover; otherwise => fail closed;
 *   - MALFORMED lock data => fail closed (an unreadable lock may be a live
 *     writer's partial state); the operator removes it after investigation;
 *   - release deletes the lock only when the on-disk body is EXACTLY the one
 *     this process wrote and verified (pid + hostname + startedAt), so an
 *     old owner can never remove a successor's lock — including under pid
 *     reuse, because startedAt differs.
 *
 * This is local-machine serialization, not distributed locking: no leases,
 * no heartbeats (out of scope by task constraint). Cross-host locks (WSL vs
 * Windows on one shared directory) fail closed.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export interface LockFileBody {
  pid: number;
  hostname: string;
  startedAt: number;
}

export interface Ownership {
  kind: "acquired" | "held-elsewhere";
  owner: LockFileBody | undefined;
}

/** Captured once at module load; same-pid attribution evidence (pid reuse). */
const MODULE_BOOT = Date.now();
/** relayDir -> the exact lock body THIS process wrote and verified. */
const acquisitions = new Map<string, LockFileBody>();

function lockPath(relayDir: string): string {
  return join(relayDir, "mcp-owner.lock");
}

function sameBody(a: LockFileBody, b: LockFileBody): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;
}

type LockRead = { status: "absent" } | { status: "malformed" } | { status: "ok"; body: LockFileBody };

async function readLockFile(path: string): Promise<LockRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.hostname !== "string" ||
      parsed.hostname.length === 0 ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return { status: "malformed" };
    }
    return { status: "ok", body: { pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt } };
  } catch {
    return { status: "malformed" };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic exclusive create of the lock file with our body. */
async function createLockExclusive(relayDir: string, body: LockFileBody): Promise<"created" | "exists"> {
  try {
    const fh = await open(lockPath(relayDir), "wx");
    try {
      await fh.writeFile(`${JSON.stringify(body)}\n`);
    } finally {
      await fh.close();
    }
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
}

/**
 * Try to become the owning MCP writer for this workspace.
 * Resolves with `held-elsewhere` (never throws) when acquisition is refused.
 */
export async function takeWorkspaceOwnership(
  relayDir: string,
  options: { now?: () => number } = {},
): Promise<Ownership> {
  const now = options.now ?? (() => Date.now());
  const body: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: now() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readLockFile(lockPath(relayDir));

    if (existing.status === "malformed") {
      // An unreadable lock may belong to a live writer: fail closed.
      return { kind: "held-elsewhere", owner: undefined };
    }

    if (existing.status === "absent") {
      const created = await createLockExclusive(relayDir, body);
      if (created === "exists") continue; // lost a creation race: re-evaluate
      const verify = await readLockFile(lockPath(relayDir));
      if (verify.status === "ok" && sameBody(verify.body, body)) {
        acquisitions.set(relayDir, body);
        return { kind: "acquired", owner: body };
      }
      return { kind: "held-elsewhere", owner: verify.status === "ok" ? verify.body : undefined };
    }

    const stale = existing.body;
    if (stale.hostname !== body.hostname) {
      // A lock written by a different host (e.g. WSL vs Windows on the same
      // directory): pid liveness is meaningless across OSes, so stay closed.
      // The operator removes the lock after confirming that owner is gone.
      return { kind: "held-elsewhere", owner: stale };
    }
    if (stale.pid === process.pid) {
      const mine = acquisitions.get(relayDir);
      if (mine !== undefined && sameBody(mine, stale)) {
        return { kind: "acquired", owner: mine }; // idempotent re-entry
      }
      if (stale.startedAt < MODULE_BOOT) {
        // PID reuse: a predecessor with our pid wrote this before this
        // process existed; pids are unique among live processes, so the
        // writer is provably dead. Fall through to the claimed takeover.
      } else {
        // Same-pid lock we cannot attribute (future-dated or concurrent
        // same-process writer): fail closed.
        return { kind: "held-elsewhere", owner: stale };
      }
    } else if (pidAlive(stale.pid)) {
      return { kind: "held-elsewhere", owner: stale };
    }

    // Stale lock (dead owner or provably dead same-pid predecessor):
    // atomic claim — exactly ONE successor's rename can succeed.
    const tomb = join(relayDir, `mcp-owner.lock.stale.${process.pid}.${randomUUID()}`);
    try {
      await rename(lockPath(relayDir), tomb);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // someone else claimed first
      throw err;
    }
    const claimed = await readLockFile(tomb);
    if (claimed.status !== "ok" || !sameBody(claimed.body, stale)) {
      // The claimed file is not the stale body we judged: restore it and
      // stay closed (a live replacement must not be stolen).
      try {
        await rename(tomb, lockPath(relayDir));
      } catch {
        await rm(tomb, { force: true }); // lockPath exists again: drop the tombstone
      }
      return { kind: "held-elsewhere", owner: claimed.status === "ok" ? claimed.body : undefined };
    }
    await rm(tomb, { force: true });
    const created = await createLockExclusive(relayDir, body);
    if (created === "exists") continue; // a successor won the recreate race: re-evaluate
    const verify = await readLockFile(lockPath(relayDir));
    if (verify.status === "ok" && sameBody(verify.body, body)) {
      acquisitions.set(relayDir, body);
      return { kind: "acquired", owner: body };
    }
    return { kind: "held-elsewhere", owner: verify.status === "ok" ? verify.body : undefined };
  }
  return { kind: "held-elsewhere", owner: undefined };
}

/**
 * Best-effort release. Removes the lock only when the on-disk body is
 * EXACTLY the one this process wrote and verified — never a successor's
 * lock, even one that happens to reuse this pid.
 */
export async function releaseWorkspaceOwnership(relayDir: string): Promise<void> {
  const mine = acquisitions.get(relayDir);
  if (mine === undefined) return;
  const current = await readLockFile(lockPath(relayDir));
  if (current.status === "ok" && sameBody(current.body, mine)) {
    await rm(lockPath(relayDir), { force: true });
  }
  acquisitions.delete(relayDir);
}

export async function lockExists(relayDir: string): Promise<boolean> {
  return stat(lockPath(relayDir)).then(
    () => true,
    () => false,
  );
}
