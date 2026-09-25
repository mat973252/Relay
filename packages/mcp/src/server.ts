/**
 * @relay/mcp — host-independent stdio MCP server (vertical slice).
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio (the standard MCP
 * transport). Implemented directly — no SDK dependency — so the surface is
 * exactly: initialize, tools/list, tools/call.
 *
 * Safety shape:
 *   - Only explicitly configured actions (mcp-actions.json) are executable;
 *     the model supplies an operationId, never a destination or credential.
 *   - The server owns the workspace (single-writer lock) BEFORE any effect
 *     tool is offered; a second live server fails closed with a status tool.
 *   - Ambiguous outcomes return UNKNOWN with an explicit "do not retry;
 *     reconcile" instruction, and unresolved operations are listable so a
 *     fresh session reuses operation ids instead of inventing new ones.
 */
import { AmbiguousEffectError, runEffect, type EffectRecord } from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { loadActions, actionFingerprint, DEFAULT_HTTP_TIMEOUT_MS, type ActionsFile, type ConfiguredAction } from "./actions.js";
import { takeWorkspaceOwnership, releaseWorkspaceOwnership } from "./lock.js";
import { envHeaderValue } from "./env.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "relay", version: "0.1.0" };
const MAX_INTENT_LENGTH = 500;

export interface RelayMcpServerOptions {
  /** Workspace directory (journal at <workspace>/.relay/storage.db). */
  workspace: string;
  /** Override the actions file discovery for tests. */
  actions?: ActionsFile;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export class RelayMcpServer {
  private readonly journal: Promise<SqliteEffectJournal>;
  private readonly actions: ActionsFile;
  private readonly relayDir: string;
  private ownership: { kind: "acquired" | "held-elsewhere"; owner: { pid: number; hostname: string } | undefined } | undefined;
  /** Per-journal-key promise chain: same-key tool calls linearize (FIFO). */
  private readonly keyQueue = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly options: RelayMcpServerOptions,
    actions: ActionsFile,
  ) {
    this.actions = actions;
    this.relayDir = join(options.workspace, ".relay");
    this.journal = SqliteEffectJournal.open({ path: join(this.relayDir, "storage.db") });
  }

  static async create(options: RelayMcpServerOptions): Promise<RelayMcpServer> {
    const actions = options.actions ?? (await loadActions(join(options.workspace, ".relay")));
    const server = new RelayMcpServer(options, actions);
    server.ownership = await takeWorkspaceOwnership(server.relayDir);
    return server;
  }

  async stop(): Promise<void> {
    await releaseWorkspaceOwnership(this.relayDir);
    (await this.journal).close();
  }

  // -- tool surface ---------------------------------------------------------

  private effectTools(): ToolDefinition[] {
    return [
      {
        name: "relay_submit_action",
        description:
          "Execute one configured external action exactly once per operationId. " +
          "CRITICAL: before submitting, call relay_list_unresolved and REUSE any existing " +
          "operationId for the same intent — inventing a new id for a retry can duplicate " +
          "a non-replayable external effect. An UNKNOWN result means the outcome is ambiguous: " +
          "do NOT resubmit; call relay_reconcile_operation.",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "string", enum: this.actions.actions.map((a) => a.id) },
            operationId: { type: "string", minLength: 1, description: "Stable, domain-specific operation id (survives sessions)" },
            intent: {
              type: "string",
              maxLength: 500,
              description:
                "Short non-secret description of the intended effect, listed by relay_list_unresolved so a fresh session can recognize this operation. Never put credentials here.",
            },
          },
          required: ["actionId", "operationId"],
        },
      },
      {
        name: "relay_list_unresolved",
        description:
          "List effect operations in PREPARED/SUBMITTED/UNKNOWN state for this workspace, " +
          "with actionId, operationId, status, and the recorded non-secret intent. " +
          "Call this FIRST when (re)starting work, and reuse the listed operation ids instead " +
          "of creating new ones.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "relay_reconcile_operation",
        description:
          "Read-only reconciliation of an ambiguous (SUBMITTED/UNKNOWN) operation against the " +
          "configured provider. Confirms CONFIRMED when the remote side reports the effect; " +
          "reports FAILED only when the provider proves it never executed. Never creates a " +
          "journal record: absent keys return an explicit absent result and PREPARED records " +
          "report that execution never began (continue with relay_submit_action).",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "string", enum: this.actions.actions.map((a) => a.id) },
            operationId: { type: "string", minLength: 1 },
          },
          required: ["actionId", "operationId"],
        },
      },
      {
        name: "relay_get_operation",
        description: "Read the current journal state of one operation.",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "string", enum: this.actions.actions.map((a) => a.id) },
            operationId: { type: "string", minLength: 1 },
          },
          required: ["actionId", "operationId"],
        },
      },
    ];
  }

  private statusTool(): ToolDefinition {
    return {
      name: "relay_status",
      description:
        "Relay is present but FAIL-CLOSED: another MCP process owns this workspace. " +
        "No effect tools are offered while that owner is alive.",
      inputSchema: { type: "object", properties: {} },
    };
  }

  // -- protocol -------------------------------------------------------------

  async handle(request: JsonRpcRequest): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    if (request.method === "initialize") {
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            ...SERVER_INFO,
            ownership: this.ownership?.kind ?? "unknown",
          },
        },
      };
    }
    if (request.method === "tools/list") {
      return { result: { tools: this.isOwner() ? this.effectTools() : [this.statusTool()] } };
    }
    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name === "relay_status") {
        return {
          result: {
            content: [{ type: "text", text: JSON.stringify(this.ownership ?? { kind: "unknown" }) }],
            isError: false,
          },
        };
      }
      if (!this.isOwner()) {
        return {
          result: {
            content: [
              {
                type: "text",
                text: `FAIL-CLOSED: workspace owned by pid ${String(this.ownership?.owner?.pid)} on ${String(this.ownership?.owner?.hostname)}; this process will not execute effects`,
              },
            ],
            isError: true,
          },
        };
      }
      try {
        const args = params.arguments ?? {};
        if (params.name === "relay_submit_action") {
          return { result: await this.submit(args) };
        }
        if (params.name === "relay_list_unresolved") {
          return { result: await this.listUnresolved() };
        }
        if (params.name === "relay_reconcile_operation") {
          return { result: await this.reconcile(args) };
        }
        if (params.name === "relay_get_operation") {
          return { result: await this.getOperation(args) };
        }
        return { error: { code: -32601, message: `unknown tool: ${String(params.name)}` } };
      } catch (err) {
        return {
          result: {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        };
      }
    }
    return { error: { code: -32601, message: `unknown method: ${request.method}` } };
  }

  private isOwner(): boolean {
    return this.ownership?.kind === "acquired";
  }

  // -- effect wiring --------------------------------------------------------

  private actionFor(actionId: unknown): ConfiguredAction {
    const action = this.actions.actions.find((a) => a.id === actionId);
    if (action === undefined) {
      throw new Error(`unknown actionId ${String(actionId)} (not in the configured action list)`);
    }
    return action;
  }

  private static operationIdFor(raw: unknown): string {
    if (typeof raw !== "string" || raw.length === 0) throw new Error("operationId must be a non-empty string");
    return raw;
  }

  /** Non-secret intent metadata (recovery aid); never part of request identity. */
  private static intentFor(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_INTENT_LENGTH) {
      throw new Error(`intent must be a non-empty string of at most ${String(MAX_INTENT_LENGTH)} characters`);
    }
    return raw;
  }

  /**
   * Linearize same-key work: a second call for the same journal key waits
   * for the previous one to settle. A not-found observation can therefore
   * never race an in-flight execution into a false FAILED.
   */
  private enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.keyQueue.get(key) ?? Promise.resolve();
    const next = prev.then(run, run); // run regardless of the previous outcome
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.keyQueue.set(key, tail);
    void tail.then(() => {
      if (this.keyQueue.get(key) === tail) this.keyQueue.delete(key);
    });
    return next;
  }

  /** Request identity: action + operation + config semantics. Intent excluded. */
  private static requestFor(action: ConfiguredAction, operationId: string): Record<string, string> {
    return { actionId: action.id, operationId, config: actionFingerprint(action) };
  }

  private async submit(args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
    const action = this.actionFor(args.actionId);
    const operationId = RelayMcpServer.operationIdFor(args.operationId);
    const intent = RelayMcpServer.intentFor(args.intent);
    const key = `${action.id}:${operationId}`;
    const journal = await this.journal;
    const outcome = await this.enqueue(key, () =>
      runEffect({
        key,
        kind: `mcp:${action.id}`,
        request: RelayMcpServer.requestFor(action, operationId),
        intent,
        replay: "never",
        journal,
        execute: async () => RelayMcpServer.executeAction(action, operationId),
        reconcile: async (record) => RelayMcpServer.reconcileAction(action, record),
      }),
    );
    const text =
      outcome.status === "unknown"
        ? `${JSON.stringify(outcome)}\nOUTCOME AMBIGUOUS — do NOT resubmit this operationId. Call relay_reconcile_operation { actionId: "${action.id}", operationId: "${operationId}" } and act on its result.`
        : JSON.stringify(outcome);
    return { content: [{ type: "text", text }], isError: outcome.status === "failed" };
  }

  private static async executeAction(action: ConfiguredAction, operationId: string): Promise<unknown> {
    const headers: Record<string, string> = { ...action.http.headers };
    for (const [header, envName] of Object.entries(action.http.secretHeaders ?? {})) {
      const value = envHeaderValue(envName);
      if (value === undefined) {
        throw new Error(`secret reference ${envName} for action "${action.id}" is not set — refusing to submit`);
      }
      headers[header] = value;
    }
    const url = action.http.url.replace("{operationId}", encodeURIComponent(operationId));
    const timeoutMs = action.http.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const rejectStatuses = action.http.rejectStatuses ?? [];
    let res: Response;
    try {
      res = await fetch(url, { method: action.http.method, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // No definitive answer (network error, timeout, abort): the effect may
      // or may not have been committed remotely. UNKNOWN, never FAILED.
      throw new AmbiguousEffectError(
        `request for ${action.id} gave no definitive answer within ${String(timeoutMs)}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      if (rejectStatuses.includes(res.status)) {
        // The operator's provider contract proves this status is a
        // pre-commit rejection: a definitive failure.
        throw new Error(`provider rejected ${action.id}: HTTP ${String(res.status)} (configured pre-commit rejection)`);
      }
      // Providers may commit and still answer with an error (409/408
      // included); proxies may emit ambiguous statuses. Default UNKNOWN.
      throw new AmbiguousEffectError(
        `provider answered HTTP ${String(res.status)} for ${action.id}: not provably a pre-commit rejection`,
      );
    }
    try {
      return (await res.json()) as unknown;
    } catch (err) {
      throw new AmbiguousEffectError(
        `provider 2xx body for ${action.id} was not parseable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private static async reconcileAction(
    action: ConfiguredAction,
    record: EffectRecord,
  ): Promise<{ found: true; remoteRef: string; result: unknown } | { found: false } | { found: "uncertain"; reason: string }> {
    const operationId = record.key.slice(action.id.length + 1);
    const url = action.reconcile.url.replace("{operationId}", encodeURIComponent(operationId));
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        return { found: "uncertain", reason: `reconcile endpoint HTTP ${String(res.status)}` };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const executed =
        action.reconcile.shape === "found-flag" ? body.found === true : body.status === "complete";
      if (!executed) return { found: false };
      return { found: true, remoteRef: operationId, result: body };
    } catch (err) {
      return { found: "uncertain", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async listUnresolved(): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
    const journal = await this.journal;
    const records = await journal.list();
    const unresolved = records.filter((r) => r.status !== "CONFIRMED" && r.status !== "FAILED");
    const text =
      unresolved.length === 0
        ? "no unresolved operations"
        : JSON.stringify(
            unresolved.map((r) => {
              // key is `${actionId}:${operationId}` and action ids are slugs
              // without colons, so the FIRST colon splits them exactly.
              const split = r.key.indexOf(":");
              const actionId = split === -1 ? r.key : r.key.slice(0, split);
              const operationId = split === -1 ? "" : r.key.slice(split + 1);
              const entry: Record<string, unknown> = {
                key: r.key,
                actionId,
                operationId,
                status: r.status,
                updatedAt: r.updatedAt,
              };
              if (r.intentJson !== undefined) entry.intent = r.intentJson;
              return entry;
            }),
          );
    return { content: [{ type: "text", text }], isError: false };
  }

  private async reconcile(args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
    const action = this.actionFor(args.actionId);
    const operationId = RelayMcpServer.operationIdFor(args.operationId);
    const key = `${action.id}:${operationId}`;
    const journal = await this.journal;
    const outcome = await this.enqueue(key, async () => {
      // Read-only pre-check: reconciliation must never CREATE journal state
      // and never touch the provider for keys with nothing in flight.
      const existing = await journal.getByKey(key);
      if (existing === undefined) {
        return {
          status: "absent" as const,
          key,
          note: "no journal record exists for this operation — nothing was ever submitted through Relay; submit it first if the effect is still intended",
        };
      }
      if (existing.status === "PREPARED") {
        return {
          status: "prepared" as const,
          key,
          note: "execution never began (no remote request was made for this record); continue with relay_submit_action using the SAME operationId",
        };
      }
      return runEffect({
        key,
        kind: `mcp:${action.id}`,
        request: RelayMcpServer.requestFor(action, operationId),
        replay: "never",
        journal,
        execute: async () => {
          throw new Error("reconcile-only call reached execute on an existing record; refusing");
        },
        reconcile: async (record) => RelayMcpServer.reconcileAction(action, record),
      });
    });
    return { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: outcome.status === "failed" };
  }

  private async getOperation(args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
    const action = this.actionFor(args.actionId);
    const operationId = RelayMcpServer.operationIdFor(args.operationId);
    const journal = await this.journal;
    const record = await journal.getByKey(`${action.id}:${operationId}`);
    return {
      content: [{ type: "text", text: record === undefined ? "not found" : JSON.stringify(record) }],
      isError: false,
    };
  }
}

/** Runs the server on the given streams (defaults to process stdio). */
export async function runStdioServer(
  options: RelayMcpServerOptions,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<RelayMcpServer> {
  const server = await RelayMcpServer.create(options);
  const rl = createInterface({ input });
  const write = (payload: unknown) => {
    output.write(`${JSON.stringify(payload)}\n`);
  };
  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (request.id === undefined || request.id === null) return; // notification
    const response = await server.handle(request);
    write({ jsonrpc: "2.0", id: request.id, ...response });
  };
  rl.on("line", (line) => {
    void handleLine(line);
  });
  return server;
}
