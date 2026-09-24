/**
 * @relay/mcp — single-writer workspace ownership (fail-closed boundary).
 *
 * v0.1's effect runner assumes ONE active writer per workspace: an in-flight
 * PREPARED record doubles as the crash-continuation state, so a second
 * concurrent server could race the first across the execute window. This
 * lock makes that assumption explicit:
 *
 *   - acquiring = atomically creating `.relay/mcp-owner.lock` (O_EXCL);
 *   - a live lock whose pid is alive on the same host => REFUSE (fail closed);
 *   - a lock whose pid is dead (crash) => take over, then re-read and verify
 *     the lock now names THIS process (guards the two-writers-takeover race;
 *     the loser sees a foreign live pid on re-read and stays closed).
 *
 * This is local-machine serialization, not distributed locking: no leases,
 * no heartbeats, no fencing tokens (out of scope by task constraint).
 */
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

function lockPath(relayDir: string): string {
  return join(relayDir, "mcp-owner.lock");
}

async function readLock(relayDir: string): Promise<LockFileBody | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(relayDir), "utf8")) as LockFileBody;
  } catch {
    return undefined;
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

async function writeLockAtomic(relayDir: string, body: LockFileBody): Promise<void> {
  const tmp = join(relayDir, `mcp-owner.lock.${body.pid}.tmp`);
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify(body)}\n`);
  } finally {
    await fh.close();
  }
  await rename(tmp, lockPath(relayDir));
}

/**
 * Try to become the owning MCP writer for this workspace.
 * Resolves with `held-elsewhere` (never throws) when a live owner exists.
 */
export async function takeWorkspaceOwnership(
  relayDir: string,
  options: { now?: () => number; settleMs?: number } = {},
): Promise<Ownership> {
  const now = options.now ?? (() => Date.now());
  const body: LockFileBody = { pid: process.pid, hostname: hostname(), startedAt: now() };
  const existing = await readLock(relayDir);
  if (existing === undefined) {
    try {
      const fh = await open(lockPath(relayDir), "wx");
      await fh.writeFile(`${JSON.stringify(body)}\n`);
      await fh.close();
      return { kind: "acquired", owner: body };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lost a creation race: fall through to the held-elsewhere check.
        const winner = await readLock(relayDir);
        if (winner !== undefined && winner.hostname === body.hostname && pidAlive(winner.pid)) {
          return { kind: "held-elsewhere", owner: winner };
        }
      } else {
        throw err;
      }
    }
  } else if (existing.hostname === body.hostname && pidAlive(existing.pid)) {
    return { kind: "held-elsewhere", owner: existing };
  } else if (existing.hostname !== body.hostname) {
    // A lock written by a different host (e.g. WSL vs Windows on the same
    // directory): pid liveness is meaningless across OSes, so stay closed.
    // The operator removes the lock after confirming that owner is gone.
    return { kind: "held-elsewhere", owner: existing };
  }

  // Stale lock (dead owner or foreign host note): replace, then VERIFY the
  // replacement names us — if two processes took over simultaneously, only
  // the one whose pid is in the file wins; the other stays closed.
  await writeLockAtomic(relayDir, body);
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 50));
  const verify = await readLock(relayDir);
  if (verify === undefined || verify.pid !== body.pid || verify.hostname !== body.hostname) {
    return { kind: "held-elsewhere", owner: verify };
  }
  return { kind: "acquired", owner: body };
}

/** Best-effort release; only removes the lock when it still names this process. */
export async function releaseWorkspaceOwnership(relayDir: string): Promise<void> {
  const current = await readLock(relayDir);
  if (current !== undefined && current.pid === process.pid && current.hostname === hostname()) {
    await rm(lockPath(relayDir), { force: true });
  }
}

export async function lockExists(relayDir: string): Promise<boolean> {
  return stat(lockPath(relayDir)).then(
    () => true,
    () => false,
  );
}
