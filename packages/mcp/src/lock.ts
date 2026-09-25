/**
 * @relay/mcp — single-writer workspace ownership (fail-closed boundary).
 *
 * v0.1's effect runner assumes ONE active writer per workspace: an in-flight
 * PREPARED record doubles as the crash-continuation state, so a second
 * concurrent server could race the first across the execute window. This
 * lock makes that assumption explicit.
 *
 * Review-round-2 redesign — the invariant the protocol must hold:
 *
 *   between the moment a successor first observes a stale lock and the
 *   moment it finishes installing its own, the lock path is NEVER absent,
 *   and no successor ever modifies a lock that is not the exact stale body
 *   it observed (no blind rename-away, no "restore" that can clobber).
 *
 * Mechanism (all primitives atomic on ext4/NTFS; hard links verified on
 * both, same directory only):
 *
 *   - acquiring an absent lock = `link(tmp, lock)` (exclusive create; the
 *     file appears with its full body — no partial-read window);
 *   - takeover of an observed stale body B:
 *       (1) SNAPSHOT: `link(lock, snap)` atomically captures whatever the
 *           lock is NOW; if the snapshot is not exactly B, the situation
 *           changed — yield WITHOUT touching the lock (this is what makes
 *           stealing a live owner's replacement lock impossible);
 *       (2) FENCE: `link(claimant, mcp-owner.claim.<hash(B)>)` — an
 *           exclusive, gap-free claim of THIS succession; exactly one
 *           successor can hold it. A fence whose claimant is provably dead
 *           (dead pid, or same-pid predecessor via startedAt) is
 *           TRANSFERRED by a single atomic rename replacement — snapshot
 *           verified against the exact dead body and read back afterwards —
 *           so the fence name is never absent and the succession is never
 *           unprotected; foreign/unattributable claimants fail closed;
 *       (3) re-SNAPSHOT: the lock must STILL be exactly B;
 *       (4) INSTALL: `rename(next, lock)` — ONE atomic replacement. The
 *           lock path is never absent, so no third process can slip into a
 *           gap and become an unclaimed owner;
 *       (5) read-back verify; only then is the acquisition recorded.
 *   - PID REUSE: a lock naming THIS pid that this process did not write is
 *     attributable through `startedAt`: written before this module loaded
 *     => the writer is provably dead => takeover; otherwise => fail closed.
 *   - MALFORMED lock data => fail closed (an unreadable lock may be a live
 *     writer's state); the operator removes it after investigation.
 *   - release deletes the lock only when the on-disk body is EXACTLY the
 *     one this process wrote and verified (pid + hostname + startedAt), so
 *     an old owner can never remove a successor's lock — including under
 *     pid reuse, because startedAt differs.
 *
 * Crash litter: unique-named snap/next/claimant/fsnap files are inert
 * debris. A lingering `mcp-owner.claim.<hash>` fence gates ONLY the
 * succession whose stale body hash it carries: while that body still sits
 * on the lock, a dead claimant's fence is transferred atomically (see (2));
 * once the lock has been replaced the fence is never consulted again —
 * bodies of later generations hash to different fence names. Legacy
 * tombstones from the previous design are swept opportunistically after
 * acquisition.
 *
 * This is local-machine serialization, not distributed locking: no leases,
 * no heartbeats (out of scope by task constraint). Cross-host locks (WSL vs
 * Windows on one shared directory) fail closed.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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

function fencePath(relayDir: string, hash: string): string {
  return join(relayDir, `mcp-owner.claim.${hash}`);
}

/** Stable short identity of an observed body (succession key). */
function bodyHash(body: LockFileBody): string {
  return createHash("sha256")
    .update(JSON.stringify([body.pid, body.hostname, body.startedAt]), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function uniquePath(relayDir: string, kind: string): string {
  return join(relayDir, `mcp-owner.${kind}.${process.pid}.${randomUUID()}`);
}

function sameBody(a: LockFileBody, b: LockFileBody): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;
}

type LockRead = { status: "absent" } | { status: "malformed" } | { status: "ok"; body: LockFileBody };

/** Parses {pid, hostname, startedAt}; extra fields (e.g. fence `for`) are tolerated. */
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

/** Liveness of a fence claimant; unattributable identities count as alive (fail closed). */
function claimantAlive(id: LockFileBody): boolean {
  if (id.hostname !== hostname()) return true;
  if (id.pid === process.pid) return id.startedAt >= MODULE_BOOT; // < boot ⇒ dead predecessor (pid reuse)
  return pidAlive(id.pid);
}

async function writeBodyFile(path: string, body: object): Promise<void> {
  await writeFile(path, `${JSON.stringify(body)}\n`, { flag: "wx" });
}

/** Atomic capture of the CURRENT lock content via a hard link. null = lock vanished. */
async function captureSnapshot(relayDir: string): Promise<{ path: string; read: LockRead } | null> {
  const snap = uniquePath(relayDir, "snap");
  try {
    await link(lockPath(relayDir), snap);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return { path: snap, read: await readLockFile(snap) };
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => undefined)));
}

/** Best-effort sweep of tombstones left by the previous lock design. */
async function sweepLegacyTombstones(relayDir: string): Promise<void> {
  try {
    for (const name of await readdir(relayDir)) {
      if (name.startsWith("mcp-owner.lock.stale.")) {
        await rm(join(relayDir, name), { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // relayDir unreadable: litter stays; harmless
  }
}

/**
 * Try to become the owning MCP writer for this workspace.
 * Resolves with `held-elsewhere` (never throws for refusals) when a live
 * owner exists or the state is not safely attributable.
 */
export async function takeWorkspaceOwnership(
  relayDir: string,
  options: { now?: () => number } = {},
): Promise<Ownership> {
  const now = options.now ?? (() => Date.now());
  const body: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: now() };
  let lastObserved: LockFileBody | undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await readLockFile(lockPath(relayDir));

    if (read.status === "malformed") {
      // An unreadable lock may belong to a live writer: fail closed.
      return { kind: "held-elsewhere", owner: undefined };
    }

    if (read.status === "absent") {
      // Exclusive create via tmp+link: the lock appears with its full body.
      const tmp = uniquePath(relayDir, "next");
      await writeBodyFile(tmp, body);
      try {
        await link(tmp, lockPath(relayDir));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          await cleanup([tmp]);
          continue; // lost a creation race: re-evaluate
        }
        throw err;
      }
      await cleanup([tmp]);
      const verify = await readLockFile(lockPath(relayDir));
      if (verify.status === "ok" && sameBody(verify.body, body)) {
        acquisitions.set(relayDir, body);
        return { kind: "acquired", owner: body };
      }
      return { kind: "held-elsewhere", owner: verify.status === "ok" ? verify.body : undefined };
    }

    const stale = read.body;
    lastObserved = stale;
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
      if (!(stale.startedAt < MODULE_BOOT)) {
        // Same-pid lock we cannot attribute (future-dated or a concurrent
        // same-process writer): fail closed.
        return { kind: "held-elsewhere", owner: stale };
      }
      // startedAt < MODULE_BOOT ⇒ the writer with our pid predates this
      // process: provably dead (pids are unique among live processes).
    } else if (pidAlive(stale.pid)) {
      return { kind: "held-elsewhere", owner: stale };
    }

    // TAKEOVER of the stale body: claim and install as ONE replacement.
    const hash = bodyHash(stale);
    const next = uniquePath(relayDir, "next");
    const claimantTmp = uniquePath(relayDir, "claimant");
    await writeBodyFile(next, body);
    await writeBodyFile(claimantTmp, { pid: body.pid, hostname: body.hostname, startedAt: body.startedAt, for: hash });

    // (1) The lock must STILL be exactly the stale body we observed.
    const snap1 = await captureSnapshot(relayDir);
    if (snap1 === null) {
      await cleanup([next, claimantTmp]);
      continue; // lock vanished underneath us (release / other protocol): re-evaluate
    }
    if (snap1.read.status !== "ok" || !sameBody(snap1.read.body, stale)) {
      await cleanup([snap1.path, next, claimantTmp]);
      // The lock changed since our observation: someone else owns or is
      // installing. We never touch the lock itself — no steal, no restore.
      return { kind: "held-elsewhere", owner: snap1.read.status === "ok" ? snap1.read.body : undefined };
    }

    // (2) Exclusive fence for THIS succession (atomic create-if-absent).
    const fence = fencePath(relayDir, hash);
    try {
      await link(claimantTmp, fence);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readLockFile(fence);
      if (holder.status !== "ok" || claimantAlive(holder.body)) {
        // Alive or unattributable claimant holds the fence: fail closed.
        await cleanup([next, claimantTmp, snap1.path]);
        return { kind: "held-elsewhere", owner: stale };
      }
      // Provably dead claimant: TRANSFER the fence as ONE atomic replacement
      // (rename) — the fence name is never absent, so the succession is
      // never unprotected. Snapshot-verify first so we only ever replace
      // the exact dead body we observed; read back afterwards so a lost
      // transfer race fails closed instead of yielding two installers.
      const dead = holder.body;
      const fsnap = uniquePath(relayDir, "fsnap");
      try {
        await link(fence, fsnap);
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === "ENOENT") {
          await cleanup([next, claimantTmp, snap1.path]);
          continue; // fence vanished (another transfer): re-evaluate
        }
        throw err2;
      }
      const observed = await readLockFile(fsnap);
      await rm(fsnap, { force: true });
      if (observed.status !== "ok" || !sameBody(observed.body, dead)) {
        // The fence changed under us (another transferee won): re-evaluate.
        await cleanup([next, claimantTmp, snap1.path]);
        continue;
      }
      await rename(claimantTmp, fence); // atomic replace; fence never absent
      const transferred = await readLockFile(fence);
      if (!(transferred.status === "ok" && sameBody(transferred.body, body))) {
        // Lost the transfer race to another successor: fail closed.
        await cleanup([next, snap1.path]);
        return { kind: "held-elsewhere", owner: stale };
      }
      // Transfer won: fall through to re-verify and install WHILE holding
      // the fence — there is no unprotected interval anywhere.
    }

    // (3) Final re-verify: still exactly the stale body.
    const snap2 = await captureSnapshot(relayDir);
    if (snap2 === null || snap2.read.status !== "ok" || !sameBody(snap2.read.body, stale)) {
      const junk = [next, claimantTmp, snap1.path, fence];
      if (snap2 !== null) junk.push(snap2.path);
      await cleanup(junk);
      continue;
    }

    // (4) INSTALL: one atomic replacement — the lock path is never absent.
    try {
      await rename(next, lockPath(relayDir));
    } catch (err) {
      await cleanup([claimantTmp, snap1.path, snap2.path, fence, next]);
      return { kind: "held-elsewhere", owner: undefined };
    }

    // (5) Read-back verify, then fence-authority check, then record.
    const verify = await readLockFile(lockPath(relayDir));
    if (!(verify.status === "ok" && sameBody(verify.body, body))) {
      // We were replaced by a non-protocol writer: the lock on disk is theirs.
      await cleanup([claimantTmp, snap1.path, snap2.path, fence]);
      return { kind: "held-elsewhere", owner: verify.status === "ok" ? verify.body : undefined };
    }
    const authority = await readLockFile(fence);
    if (!(authority.status === "ok" && sameBody(authority.body, body))) {
      // Another transferee superseded our fence mid-protocol: the fence —
      // not our completed rename — is the authority for this succession.
      // Yield and remove ONLY our own exact lock body, never anyone else's.
      const current = await readLockFile(lockPath(relayDir));
      if (current.status === "ok" && sameBody(current.body, body)) {
        await rm(lockPath(relayDir), { force: true });
      }
      await cleanup([snap1.path, snap2.path]);
      return { kind: "held-elsewhere", owner: undefined };
    }
    acquisitions.set(relayDir, body);
    await cleanup([claimantTmp, snap1.path, snap2.path, fence]);
    await sweepLegacyTombstones(relayDir);
    return { kind: "acquired", owner: body };
  }
  return { kind: "held-elsewhere", owner: lastObserved };
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
