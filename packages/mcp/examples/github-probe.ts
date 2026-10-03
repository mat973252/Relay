/** Opt-in source example. Approval of the concrete plan is a human prerequisite. */
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AmbiguousEffectError, hashRequest, runEffect, type ReconcileOutcome } from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { releaseWorkspaceOwnership, takeWorkspaceOwnership } from "../src/lock.js";
import { preflight } from "./github-preflight.js";

const API = "https://api.github.com";
const KIND = "github-variable/probe";
const active = new Set<string>();
export interface ProbePlan {
  schema: "relay.github-probe/1";
  origin: string;
  repository: string;
  repositoryId: number;
  name: string;
  value: string;
  workspace: string;
  key: string;
  kind: string;
  requestHash: string;
}
type Transport = (url: string, options: RequestInit) => Promise<Response>;
interface Options { mode: "execute" | "reconcile"; token?: string | undefined; approvedPlanHash?: string | undefined; transport?: Transport }
function intent(p: ProbePlan) {
  return { origin: p.origin, repository: p.repository, repositoryId: p.repositoryId, name: p.name, value: p.value, workspace: p.workspace };
}
function validRepository(repository: unknown, id: unknown): boolean {
  return typeof repository === "string" && /^[A-Za-z0-9-]+\/[\w.-]+$/.test(repository)
    && ![".", ".."].includes(repository.split("/")[1] ?? "") && Number.isSafeInteger(id) && Number(id) > 0;
}
export async function createProbePlan(input: { repository: string; repositoryId: number; workspace: string }): Promise<ProbePlan> {
  if (!validRepository(input.repository, input.repositoryId) || !input.workspace) throw new Error("invalid plan arguments");
  await mkdir(resolve(input.workspace), { recursive: true });
  const nonce = randomUUID().replaceAll("-", "").toUpperCase();
  const plan: ProbePlan = {
    schema: "relay.github-probe/1", origin: API, repository: input.repository, repositoryId: input.repositoryId,
    name: `RELAY_PROBE_${nonce}`, value: `relay-probe:${nonce}`, workspace: await realpath(resolve(input.workspace)),
    key: `github-variable:${input.repositoryId}:${nonce}`, kind: KIND, requestHash: "",
  };
  plan.requestHash = hashRequest(intent(plan));
  return plan;
}
function validated(value: unknown): ProbePlan | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const p = value as ProbePlan;
  const keys = ["schema", "origin", "repository", "repositoryId", "name", "value", "workspace", "key", "kind", "requestHash"];
  if (Object.keys(p).length !== keys.length || !Object.keys(p).every((key) => keys.includes(key))) return undefined;
  if (p.schema !== "relay.github-probe/1" || p.origin !== API || p.kind !== KIND || !validRepository(p.repository, p.repositoryId)
    || typeof p.name !== "string" || !/^RELAY_PROBE_[A-F0-9]{32}$/.test(p.name) || typeof p.workspace !== "string" || !p.workspace) return undefined;
  const nonce = p.name.slice("RELAY_PROBE_".length);
  if (p.value !== `relay-probe:${nonce}` || p.key !== `github-variable:${p.repositoryId}:${nonce}` || p.requestHash !== hashRequest(intent(p))) return undefined;
  // Copy all validated scalars so callers cannot change the reviewed plan while awaiting I/O.
  return { schema: p.schema, origin: p.origin, repository: p.repository, repositoryId: p.repositoryId, name: p.name, value: p.value, workspace: p.workspace, key: p.key, kind: p.kind, requestHash: p.requestHash };
}

export async function runProbe(value: unknown, options: Options) {
  let postAttempts = 0;
  let getAttempts = 0;
  const report = (status: string, reason: string) => ({ schema: "relay.github-probe-result/1", status, reason, postAttempts, getAttempts });
  const checkedPlan = validated(value);
  if (!checkedPlan || !["execute", "reconcile"].includes(options.mode)) return report("blocked", "invalid_plan");
  const p: ProbePlan = checkedPlan;
  const { mode, token, approvedPlanHash } = options;
  if (mode === "execute" && approvedPlanHash !== hashRequest(p)) return report("blocked", "approval_required");
  if (mode === "execute" && !token) return report("blocked", "token_missing");
  let canonical: string;
  try { canonical = await realpath(p.workspace); } catch { return report("blocked", "workspace_missing"); }
  if (canonical !== p.workspace) return report("blocked", "workspace_mismatch");
  const activeKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  if (active.has(activeKey)) return report("blocked", "workspace_busy");
  active.add(activeKey);
  let acquired = false;
  try {
    const ownership = await takeWorkspaceOwnership(canonical, { reentrant: false });
    if (ownership.kind !== "acquired") return report("blocked", "workspace_locked");
    acquired = true;
    const journal = await SqliteEffectJournal.open({ path: join(canonical, "journal.db") });
    try {
      const existing = await journal.getByKey(p.key);
      if (existing && (existing.kind !== p.kind || existing.requestHash !== p.requestHash || existing.replay !== "never")) return report("blocked", "record_mismatch");
      if (mode === "execute" && existing) return report("blocked", "existing_record");
      if (mode === "reconcile") {
        if (!existing) return report("blocked", "record_missing");
        if (existing.status === "PREPARED") return report("prepared_not_submitted", "read_only_no_submit");
        if (existing.status === "CONFIRMED" || existing.status === "FAILED") return report(existing.status.toLowerCase(), "terminal_cached");
      }
      if (!token) return report("blocked", "token_missing");
      const transport = options.transport ?? fetch;
      const counted: Transport = async (url, request) => {
        if (request.method === "POST") postAttempts++; else getAttempts++;
        return transport(url, request);
      };
      const repoPath = `/repos/${p.repository}`;
      async function http(path: string, method = "GET", body?: string) {
        return counted(`${API}${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(10000),
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
          ...(body === undefined ? {} : { body }),
        });
      }
      async function identity(): Promise<boolean> {
        const response = await http(repoPath);
        if (response.status !== 200) return false;
        const body = await response.json() as { id?: unknown; full_name?: unknown } | null;
        return body?.id === p.repositoryId && typeof body.full_name === "string" && body.full_name.toLowerCase() === p.repository.toLowerCase();
      }
      async function reconcile(): Promise<ReconcileOutcome> {
        try {
          if (await identity()) {
            const response = await http(`${repoPath}/actions/variables/${p.name}`);
            if (response.status === 200) {
              const body = await response.json() as { name?: unknown; value?: unknown } | null;
              if (body?.name === p.name && body.value === p.value) return { found: true, remoteRef: undefined, result: { repositoryId: p.repositoryId, name: p.name, value: p.value } };
            }
          }
        } catch { /* Unavailable evidence cannot prove non-execution. */ }
        return { found: "uncertain", reason: "matching_remote_state_unverified" };
      }
      if (mode === "execute" && (await preflight(p, token, counted)).status !== "enumeration_complete") return report("blocked", "preflight_blocked");
      const outcome = await runEffect({
        key: p.key, kind: p.kind, request: intent(p), replay: "never", journal, reconcile,
        execute: async () => {
          if (mode !== "execute") throw new AmbiguousEffectError("read_only_entry_cannot_submit");
          // Failures here precede the POST invocation and cannot represent a sent request.
          try { if (!await identity()) throw new Error("identity changed"); }
          catch { throw new Error("repository_unverified_before_post"); }
          try {
            const response = await http(`${repoPath}/actions/variables`, "POST", JSON.stringify({ name: p.name, value: p.value }));
            if (response.status !== 201) throw new Error("unproven response");
            const checked = await reconcile();
            if (checked.found !== true) throw new Error("unproven state");
            return checked.result;
          } catch { throw new AmbiguousEffectError("submission_not_confirmed"); }
        },
      });
      return report(outcome.status, outcome.status === "confirmed" ? "matching_or_cached_evidence" : outcome.status === "failed" ? "failed_before_post" : "remote_state_unverified");
    } finally { journal.close(); }
  } catch { return report("error", "runner_failed_inspect_journal"); }
  finally {
    try { if (acquired) await releaseWorkspaceOwnership(canonical); }
    catch { return report("error", "lock_release_failed_inspect_journal"); }
    finally { active.delete(activeKey); }
  }
}
