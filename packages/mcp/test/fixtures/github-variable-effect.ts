/** Test-only adapter. External origins are deliberately unsupported. */
import { AmbiguousEffectError, runEffect, type ReconcileOutcome } from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { releaseWorkspaceOwnership, takeWorkspaceOwnership } from "../../src/lock.js";

export interface VariableIntent {
  baseUrl: string;
  repository: string;
  repositoryId: number;
  name: string;
  value: string;
}

export async function runLocalVariable(
  workspace: string,
  intent: VariableIntent,
  token: string,
  options: { crashPrepared?: boolean; afterAcquire?: () => Promise<void> } = {},
) {
  intent = { ...intent };
  const origin = new URL(intent.baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== intent.baseUrl) {
    throw new Error("local contract only: expected a loopback origin");
  }
  if (!/^[\w-]+\/[\w-]+$/.test(intent.repository) || !/^RELAY_PROBE_[A-Z0-9_]+$/.test(intent.name) || !Number.isSafeInteger(intent.repositoryId)) {
    throw new Error("invalid synthetic context");
  }
  await mkdir(workspace, { recursive: true });
  const ownership = await takeWorkspaceOwnership(workspace, { reentrant: false });
  if (ownership.kind !== "acquired") return { status: "locked" as const };
  try {
    await options.afterAcquire?.();
    const journal = await SqliteEffectJournal.open({ path: join(workspace, "journal.db") });
    try {
      const repoPath = `/repos/${intent.repository}`;
      async function http(path: string, method = "GET", body?: string) {
        return fetch(`${intent.baseUrl}${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(1000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body }),
        });
      }
      async function correctRepository() {
        const response = await http(repoPath);
        if (!response.ok) return false;
        const body = await response.json() as { id?: unknown };
        return body.id === intent.repositoryId;
      }
      async function reconcile(): Promise<ReconcileOutcome> {
        try {
          if (await correctRepository()) {
            const response = await http(`${repoPath}/actions/variables/${intent.name}`);
            if (response.ok) {
              const body = await response.json() as { name?: unknown; value?: unknown };
              if (body.name === intent.name && body.value === intent.value) {
                return { found: true, remoteRef: undefined, result: { repositoryId: intent.repositoryId, name: intent.name, value: intent.value } };
              }
            }
          }
        } catch { /* No authority to infer nonexecution from an unavailable query. */ }
        return { found: "uncertain", reason: "context or remote state not proven" };
      }
      return await runEffect({
        key: "github-variable:fixture-operation", kind: "github-variable/local-contract", request: intent,
        replay: "never", journal,
        execute: async () => {
          try {
            if (!await correctRepository()) throw new Error("context mismatch");
            const response = await http(`${repoPath}/actions/variables`, "POST", JSON.stringify({ name: intent.name, value: intent.value }));
            if (response.status !== 201) throw new Error("unproven submit response");
            const checked = await reconcile();
            if (checked.found !== true) throw new Error("unproven submitted state");
            return checked.result;
          } catch {
            // Never persist raw HTTP errors, response bodies, or authentication.
            throw new AmbiguousEffectError("submission not confirmed by matching query");
          }
        },
        reconcile,
        ...(options.crashPrepared ? { crash: { point: "after-prepared-commit" as const, kill: (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("unreachable"); } } } : {}),
      });
    } finally { journal.close(); }
  } finally { await releaseWorkspaceOwnership(workspace); }
}
