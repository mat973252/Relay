/**
 * @relay/mcp — configured external actions (v0.1: exactly the demoed class).
 *
 * The model never supplies destinations or credentials: every URL, method,
 * and secret-header reference comes from a local, operator-owned config file
 * (`.relay/mcp-actions.json`). This is deliberately NOT a generic
 * arbitrary-URL proxy.
 *
 * Safety-review additions: both endpoints must literally bind
 * `{operationId}` (otherwise exactly-once cannot be anchored to the
 * operation id), HTTP outcomes default to UNKNOWN and only statuses the
 * operator explicitly lists as proven pre-commit rejections may settle
 * FAILED, and submit requests carry a bounded timeout.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stableStringify } from "@relay/core";

export interface HttpActionEndpoint {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  /** Extra static headers (values are config data, not secrets). */
  headers?: Record<string, string>;
  /** headerName -> env var NAME (never a value). */
  secretHeaders?: Record<string, string>;
  /** Upper bound on the submit request; timeouts resolve UNKNOWN, never FAILED. */
  timeoutMs?: number;
  /**
   * HTTP statuses the operator's provider contract PROVES are pre-commit
   * rejections (definitive FAILED). Everything else defaults to UNKNOWN.
   * Note: commit-then-error providers exist (409/408 included) — list a
   * status here only if the contract rules out post-commit responses.
   */
  rejectStatuses?: number[];
}

export interface ReconcileEndpoint {
  /** GET endpoint; `{operationId}` is substituted (URL-encoded). */
  url: string;
  /**
   * How to interpret a 200 response body:
   *  - "found-flag": body.found === true  => executed remotely
   *  - "status-field": body.status ∈ completeStatuses => executed remotely,
   *    body.status ∈ notExecutedStatuses => PROVEN non-execution (FAILED).
   * Every other answer (missing field, non-string, any unlisted value —
   * "pending" included) is unverifiable and leaves the operation UNKNOWN.
   */
  shape: "found-flag" | "status-field";
  /**
   * Status-field values the provider contract uses for executed/committed
   * operations. Default: ["complete"]. Status-field shape only.
   */
  completeStatuses?: string[];
  /**
   * Status-field values the operator's provider contract PROVES mean the
   * operation was never executed (definitive FAILED). Everything else —
   * including "pending" — is unresolved and stays UNKNOWN. Default: none,
   * so reconcile can never settle FAILED unless the operator opts in.
   * Status-field shape only.
   */
  notExecutedStatuses?: string[];
}

export interface ConfiguredAction {
  id: string;
  label: string;
  description?: string | undefined;
  http: HttpActionEndpoint;
  reconcile: ReconcileEndpoint;
}

/** Default submit timeout: bounded, but generous for slow providers. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Fingerprint of everything in an action config that changes the REMOTE
 * MEANING of a submission. Bound into the journal request identity so a
 * config change refuses to reuse an existing operation id for a different
 * remote effect (fail closed instead of silently re-targeting).
 * Hash only: secret env NAMES are config, secret VALUES never appear.
 */
export function actionFingerprint(action: ConfiguredAction): string {
  return createHash("sha256")
    .update(
      stableStringify({
        id: action.id,
        http: {
          url: action.http.url,
          method: action.http.method,
          headers: action.http.headers ?? {},
          secretHeaders: action.http.secretHeaders ?? {},
        },
        reconcile: { url: action.reconcile.url, shape: action.reconcile.shape },
      }),
      "utf8",
    )
    .digest("hex");
}

export interface ActionsFile {
  schema: string;
  actions: ConfiguredAction[];
}

export class ActionsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionsConfigError";
  }
}

function validateAction(raw: unknown, file: string): ConfiguredAction {
  if (typeof raw !== "object" || raw === null) throw new ActionsConfigError(`${file}: action must be a mapping`);
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || a.id.length === 0 || !/^[a-z0-9][a-z0-9-]*$/.test(a.id)) {
    throw new ActionsConfigError(`${file}: action.id must be a lowercase slug`);
  }
  if (typeof a.label !== "string" || a.label.length === 0) {
    throw new ActionsConfigError(`${file}: action "${a.id}" needs a label`);
  }
  const http = a.http as Record<string, unknown> | undefined;
  if (
    typeof http !== "object" ||
    http === null ||
    typeof http.url !== "string" ||
    !/^https?:\/\//.test(http.url) ||
    (http.method !== "POST" && http.method !== "PUT" && http.method !== "PATCH")
  ) {
    throw new ActionsConfigError(`${file}: action "${a.id}" needs http.url and a POST/PUT/PATCH method`);
  }
  if (!http.url.includes("{operationId}")) {
    throw new ActionsConfigError(
      `${file}: action "${a.id}" http.url must bind {operationId} — an endpoint that ignores the operation id cannot anchor exactly-once`,
    );
  }
  if (
    http.timeoutMs !== undefined &&
    (typeof http.timeoutMs !== "number" || !Number.isInteger(http.timeoutMs) || http.timeoutMs <= 0 || http.timeoutMs > 600_000)
  ) {
    throw new ActionsConfigError(`${file}: action "${a.id}" http.timeoutMs must be a positive integer of at most 600000`);
  }
  if (http.rejectStatuses !== undefined) {
    if (!Array.isArray(http.rejectStatuses) || http.rejectStatuses.length === 0) {
      throw new ActionsConfigError(`${file}: action "${a.id}" http.rejectStatuses must be a non-empty list when present`);
    }
    for (const status of http.rejectStatuses) {
      if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499) {
        throw new ActionsConfigError(
          `${file}: action "${a.id}" http.rejectStatuses entries must be integers in 400..499 (client-side statuses only; post-commit ambiguity stays UNKNOWN)`,
        );
      }
    }
  }
  const rec = a.reconcile as Record<string, unknown> | undefined;
  if (
    typeof rec !== "object" ||
    rec === null ||
    typeof rec.url !== "string" ||
    !/^https?:\/\//.test(rec.url) ||
    (rec.shape !== "found-flag" && rec.shape !== "status-field")
  ) {
    throw new ActionsConfigError(`${file}: action "${a.id}" needs a read-only reconcile { url, shape }`);
  }
  if (!rec.url.includes("{operationId}")) {
    throw new ActionsConfigError(
      `${file}: action "${a.id}" reconcile.url must bind {operationId} — reconciliation must observe THIS operation, not some aggregate`,
    );
  }
  for (const key of ["completeStatuses", "notExecutedStatuses"] as const) {
    const value = rec[key];
    if (value === undefined) continue;
    if (rec.shape !== "status-field") {
      throw new ActionsConfigError(`${file}: action "${a.id}" reconcile.${key} requires shape "status-field"`);
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((s) => typeof s !== "string" || s.length === 0)) {
      throw new ActionsConfigError(`${file}: action "${a.id}" reconcile.${key} must be a non-empty list of non-empty strings`);
    }
  }
  for (const [header, envName] of Object.entries((http.secretHeaders as Record<string, unknown>) ?? {})) {
    if (typeof envName !== "string" || envName.length === 0) {
      throw new ActionsConfigError(`${file}: secretHeaders values must be env var names`);
    }
    if (/authorization/i.test(header) === false && /token/i.test(header) === false) {
      // not an error, but keep the surface tight: only auth-ish headers may carry secrets
    }
  }
  return raw as ConfiguredAction;
}

/** Loads and validates `.relay/mcp-actions.json` for a workspace. */
export async function loadActions(relayDir: string): Promise<ActionsFile> {
  const file = join(relayDir, "mcp-actions.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new ActionsConfigError(
      `${file} is missing — this server exposes only explicitly configured actions; refusing to start`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ActionsConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schema !== "relay.mcp-actions/1") {
    throw new ActionsConfigError(`${file}: expected schema relay.mcp-actions/1`);
  }
  if (!Array.isArray(doc.actions) || doc.actions.length === 0) {
    throw new ActionsConfigError(`${file}: "actions" must be a non-empty list`);
  }
  const ids = new Set<string>();
  const actions = doc.actions.map((entry) => {
    const action = validateAction(entry, file);
    if (ids.has(action.id)) throw new ActionsConfigError(`${file}: duplicate action id ${action.id}`);
    ids.add(action.id);
    return action;
  });
  return { schema: doc.schema as string, actions };
}
