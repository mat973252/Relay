/**
 * @relay/mcp — single-writer workspace ownership (fail-closed boundary).
 *
 * v0.1's effect runner assumes ONE active writer per workspace: an in-flight
 * PREPARED record doubles as the crash-continuation state, so a second
 * concurrent server could race the first across the execute window. This
 * lock makes that assumption explicit.
 *
 * Windows-transfer redesign — the invariant the protocol must hold:
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
 *       (1) VERIFY: read the lock path; it must still be exactly B;
 *       (2) CLAIM-CHAIN: `link(claimant, mcp-owner.claim.<hash(B)>)` — an
 *           exclusive, gap-free claim of THIS succession. Exactly one
 *           successor can hold each level of the claim chain. When the
 *           current deepest claimant is provably dead (dead pid, or
 *           same-pid predecessor via startedAt), the claim advances one
 *           level — `link(claimant, mcp-owner.claim.<hash(B)>.t<k+1>)` —
 *           a fresh exclusive create that NEVER replaces, renames, or
 *           removes an existing claim file. This is what makes the
 *           transfer portable: Windows denies rename-replace onto a path
 *           whose inode is multiply-linked or transiently opened by a
 *           racing process (MoveFileExW+REPLACE_EXISTING → EPERM), so no
 *           rename ever targets a claim path. Every level stays present,
 *           so the succession is never unprotected; foreign or
 *           unattributable claimants fail closed;
 *       (3) re-VERIFY: the lock must STILL be exactly B;
 *       (4) INSTALL: `rename(next, lock)` — ONE atomic replacement, the
 *           only rename in the protocol. The lock path is never absent, so
 *           no third process can slip into a gap and become an unclaimed
 *           owner. The stale body is re-verified before EVERY attempt so a
 *           lock that changed underneath us is never renamed over, and
 *           transient EPERM/EACCES/EBUSY (Windows link/handle contention)
 *           is retried briefly before failing closed;
 *       (5) read-back verify, then claim-authority check (the deepest claim
 *           level must still be ours); only then is the acquisition
 *           recorded.
 *   - PID REUSE: a lock naming THIS pid that this process did not write is
 *     attributable through `startedAt`: written before this module loaded
 *     => the writer is provably dead => takeover; otherwise => fail closed.
 *   - MALFORMED lock or claim data => fail closed (an unreadable entry may
 *     be a live writer's state); the operator removes it after
 *     investigation.
 *   - release deletes the lock only when the on-disk body is EXACTLY the
 *     one this process wrote and verified (pid + hostname + startedAt), so
 *     an old owner can never remove a successor's lock — including under
 *     pid reuse, because startedAt differs.
 *
 * Crash litter: unique-named next/claimant (and legacy snap/fsnap) files
 * are inert debris, swept opportunistically alongside legacy tombstones
 * from the previous design. `mcp-owner.claim.<hash>[.t<k>]` files gate ONLY
 * the succession whose stale body hash they carry: while that body still
 * sits on the lock, dead claimants are climbed past by fresh link-creates
 * (see (2)); once the lock has been replaced the whole chain is inert —
 * bodies of later generations hash to different claim names — and is left
 * in place permanently. Claim files are never renamed, overwritten, or
 * deleted, so the transfer needs no rename-replace primitive at all.
 *
 * This is local-machine serialization, not distributed locking: no leases,
 * no heartbeats (out of scope by task constraint). Cross-host locks (WSL vs
 * Windows on one shared directory) fail closed.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

/** Hard bound on claim-chain depth; deeper means pathological -> fail closed. */
const MAX_CLAIM_LEVEL = 32;
/** Install rename retry policy for transient Windows denials (EPERM/EACCES/EBUSY). */
const INSTALL_RETRIES = 30;
const INSTALL_RETRY_DELAY_MS = 15;

function lockPath(relayDir: string): string {
  return join(relayDir, "mcp-owner.lock");
}

function fencePath(relayDir: string, hash: string): string {
  return join(relayDir, `mcp-owner.claim.${hash}`);
}

/** Level-k claim file for a succession (level 0 is the plain fence name). */
function claimPath(relayDir: string, hash: string, level: number): string {
  return level === 0 ? fencePath(relayDir, hash) : join(relayDir, `mcp-owner.claim.${hash}.t${String(level)}`);
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

/** Parses {pid, hostname, startedAt}; extra fields (e.g. claim `for`) are tolerated. */
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

/** Liveness of a claim holder; unattributable identities count as alive (fail closed). */
function claimantAlive(id: LockFileBody): boolean {
  if (id.hostname !== hostname()) return true;
  if (id.pid === process.pid) return id.startedAt >= MODULE_BOOT; // < boot ⇒ dead predecessor (pid reuse)
  return pidAlive(id.pid);
}

async function writeBodyFile(path: string, body: object): Promise<void> {
  await writeFile(path, `${JSON.stringify(body)}\n`, { flag: "wx" });
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => undefined)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort sweep of inert debris: legacy tombstones and unique-named
 * next/claimant/snap/fsnap files. `mcp-owner.claim.*` files are NEVER
 * removed, renamed, or modified — once created they are the permanent,
 * append-only record of a succession; that is what keeps the transfer
 * correct on filesystems where rename-replace is unreliable.
 */
async function sweepLitter(relayDir: string): Promise<void> {
  try {
    for (const name of await readdir(relayDir)) {
      const isDebris =
        name.startsWith("mcp-owner.lock.stale.") ||
        name.startsWith("mcp-owner.snap.") ||
        name.startsWith("mcp-owner.fsnap.") ||
        name.startsWith("mcp-owner.next.") ||
        name.startsWith("mcp-owner.claimant.");
      if (isDebris) {
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
  options: { now?: () => number; rename?: (oldPath: string, newPath: string) => Promise<void> } = {},
): Promise<Ownership> {
  const now = options.now ?? (() => Date.now());
  const renameImpl = options.rename ?? rename;
  const body: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: now() };
  let lastObserved: LockFileBody | undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let read: LockRead;
    try {
      read = await readLockFile(lockPath(relayDir));
    } catch {
      // An unreadable lock is not safely attributable: fail closed.
      return { kind: "held-elsewhere", owner: undefined };
    }

    if (read.status === "malformed") {
      // An unreadable lock may belong to a live writer: fail closed.
      return { kind: "held-elsewhere", owner: undefined };
    }

    if (read.status === "absent") {
      // Exclusive create via tmp+link: the lock appears with its full body.
      const tmp = uniquePath(relayDir, "next");
      try {
        await writeBodyFile(tmp, body);
        await link(tmp, lockPath(relayDir));
      } catch (err) {
        await cleanup([tmp]);
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          continue; // lost a creation race: re-evaluate
        }
        return { kind: "held-elsewhere", owner: undefined }; // cannot write: closed
      }
      await cleanup([tmp]);
      let verify: LockRead;
      try {
        verify = await readLockFile(lockPath(relayDir));
      } catch {
        return { kind: "held-elsewhere", owner: undefined };
      }
      if (verify.status === "ok" && sameBody(verify.body, body)) {
        acquisitions.set(relayDir, body);
        await sweepLitter(relayDir);
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

    // TAKEOVER of the stale body. Any fs error inside the claim/install
    // sequence is ambiguous: fail closed (children must always report).
    try {
      const hash = bodyHash(stale);
      const next = uniquePath(relayDir, "next");
      const claimantTmp = uniquePath(relayDir, "claimant");
      await writeBodyFile(next, body);
      await writeBodyFile(claimantTmp, {
        pid: body.pid,
        hostname: body.hostname,
        startedAt: body.startedAt,
        for: hash,
      });

      // (1) The lock must STILL be exactly the stale body we observed.
      const obs1 = await readLockFile(lockPath(relayDir));
      if (obs1.status === "absent") {
        await cleanup([next, claimantTmp]);
        continue; // lock vanished underneath us (release / other protocol): re-evaluate
      }
      if (obs1.status !== "ok" || !sameBody(obs1.body, stale)) {
        await cleanup([next, claimantTmp]);
        // The lock changed since our observation: someone else owns or is
        // installing. We never touch the lock itself — no steal, no restore.
        return { kind: "held-elsewhere", owner: obs1.status === "ok" ? obs1.body : undefined };
      }

      // (2) Exclusive claim for THIS succession. The transfer protocol is a
      // chain of exclusive link-creates — never a rename or unlink on a
      // claim path — because Windows denies rename-replace when the target
      // inode is multiply-linked or transiently opened by a racer (EPERM).
      // No claim file is ever absent once created: protection is continuous.
      let claimed = false;
      let level = 0;
      while (level <= MAX_CLAIM_LEVEL) {
        const path = claimPath(relayDir, hash, level);
        try {
          await link(claimantTmp, path);
          claimed = true;
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const holder = await readLockFile(path);
        if (holder.status === "absent") continue; // vanished mid-race: retry this level
        if (holder.status !== "ok" || claimantAlive(holder.body)) {
          // Alive or unattributable claimant holds the chain: fail closed.
          await cleanup([next, claimantTmp]);
          return { kind: "held-elsewhere", owner: stale };
        }
        // Provably dead claimant: the right to this succession advances one
        // level — claimed by the NEXT exclusive link-create, leaving the
        // dead claimant's file in place (no gap, no rename, no clobber).
        level += 1;
      }
      if (!claimed) {
        await cleanup([next, claimantTmp]);
        return { kind: "held-elsewhere", owner: stale };
      }

      // (3) Final re-verify: still exactly the stale body.
      const obs2 = await readLockFile(lockPath(relayDir));
      if (obs2.status === "absent") {
        await cleanup([next, claimantTmp]);
        continue;
      }
      if (obs2.status !== "ok" || !sameBody(obs2.body, stale)) {
        await cleanup([next, claimantTmp]);
        return { kind: "held-elsewhere", owner: obs2.status === "ok" ? obs2.body : undefined };
      }

      // (4) INSTALL: one atomic replacement — the lock path is never absent.
      // Re-verify the stale body before EVERY attempt so a lock that changed
      // underneath us is never renamed over; transient denials (a Windows
      // racer's transient link/handle on the lock inode) are retried briefly,
      // then fail closed — the claim we hold keeps the succession protected.
      let installed = false;
      for (let retry = 0; retry < INSTALL_RETRIES; retry += 1) {
        const current = await readLockFile(lockPath(relayDir));
        if (current.status !== "ok" || !sameBody(current.body, stale)) {
          await cleanup([next, claimantTmp]);
          if (current.status === "absent") break; // re-evaluate below
          return { kind: "held-elsewhere", owner: current.status === "ok" ? current.body : undefined };
        }
        try {
          await renameImpl(next, lockPath(relayDir));
          installed = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
          if (retry + 1 === INSTALL_RETRIES) {
            await cleanup([next, claimantTmp]);
            return { kind: "held-elsewhere", owner: stale };
          }
          await sleep(INSTALL_RETRY_DELAY_MS);
        }
      }
      if (!installed) {
        // The lock vanished between attempts: release-like transition.
        await cleanup([claimantTmp]);
        continue;
      }

      // (5) Read-back verify, then claim-authority check, then record.
      const verify = await readLockFile(lockPath(relayDir));
      if (!(verify.status === "ok" && sameBody(verify.body, body))) {
        // We were replaced by a non-protocol writer: the lock on disk is theirs.
        await cleanup([claimantTmp]);
        return { kind: "held-elsewhere", owner: verify.status === "ok" ? verify.body : undefined };
      }
      // The deepest existing claim level must still be ours; a deeper live
      // claimant means the chain — not our completed rename — is the
      // authority for this succession. Yield and remove ONLY our own exact
      // lock body, never anyone else's.
      let authority: LockRead = { status: "absent" };
      for (let level = 0; level <= MAX_CLAIM_LEVEL; level += 1) {
        const nextRead = await readLockFile(claimPath(relayDir, hash, level + 1));
        if (nextRead.status === "absent") {
          authority = await readLockFile(claimPath(relayDir, hash, level));
          break;
        }
      }
      if (!(authority.status === "ok" && sameBody(authority.body, body))) {
        const current = await readLockFile(lockPath(relayDir));
        if (current.status === "ok" && sameBody(current.body, body)) {
          await rm(lockPath(relayDir), { force: true });
        }
        await cleanup([claimantTmp]);
        return { kind: "held-elsewhere", owner: undefined };
      }
      acquisitions.set(relayDir, body);
      await cleanup([claimantTmp]);
      await sweepLitter(relayDir);
      return { kind: "acquired", owner: body };
    } catch {
      // Ambiguous mid-takeover failure: fail closed. The next attempter
      // climbs past any claim files we left behind (we are alive, so they
      // stay closed until we exit — the chain is correct either way).
      return { kind: "held-elsewhere", owner: stale };
    }
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
