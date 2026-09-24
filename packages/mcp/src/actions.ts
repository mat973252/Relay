/**
 * @relay/mcp — configured external actions (v0.1: exactly the demoed class).
 *
 * The model never supplies destinations or credentials: every URL, method,
 * and secret-header reference comes from a local, operator-owned config file
 * (`.relay/mcp-actions.json`). This is deliberately NOT a generic
 * arbitrary-URL proxy.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface HttpActionEndpoint {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  /** Extra static headers (values are config data, not secrets). */
  headers?: Record<string, string>;
  /** headerName -> env var NAME (never a value). */
  secretHeaders?: Record<string, string>;
}

export interface ReconcileEndpoint {
  /** GET endpoint; `{operationId}` is substituted (URL-encoded). */
  url: string;
  /**
   * How to interpret a 200 response body:
   *  - "found-flag": body.found === true  => executed remotely
   *  - "status-field": body.status === "complete" => executed remotely
   */
  shape: "found-flag" | "status-field";
}

export interface ConfiguredAction {
  id: string;
  label: string;
  description?: string | undefined;
  http: HttpActionEndpoint;
  reconcile: ReconcileEndpoint;
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
