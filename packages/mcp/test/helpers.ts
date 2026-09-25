/**
 * Shared MCP test helpers: workspace setup, stdio client with fire-then-await
 * support (same-key concurrency tests), and journal inspection.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import type { EffectRecord } from "@relay/core";

export const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));

export interface McpClient {
  /** Fire one tools/call request; returns its response promise (no queueing). */
  call: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  kill: () => void;
  exit: Promise<{ status: number | null; signal: string | null }>;
}

export function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeWorkspace(root: string, prefix: string): string {
  return mkdtempSync(join(root, `${prefix}-`));
}

export interface ActionOverrides {
  timeoutMs?: number;
  rejectStatuses?: number[];
  httpUrl?: string;
  reconcileUrl?: string;
}

export function writeActions(workspace: string, baseUrl: string, overrides: ActionOverrides = {}): void {
  mkdirSync(join(workspace, ".relay"), { recursive: true });
  writeFileSync(
    join(workspace, ".relay", "mcp-actions.json"),
    JSON.stringify(
      {
        schema: "relay.mcp-actions/1",
        actions: [
          {
            id: "counter-increment",
            label: "Increment the demo counter (non-replayable)",
            http: {
              url: overrides.httpUrl ?? `${baseUrl}/increment?operationId={operationId}`,
              method: "POST",
              ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
              ...(overrides.rejectStatuses !== undefined ? { rejectStatuses: overrides.rejectStatuses } : {}),
            },
            reconcile: {
              url: overrides.reconcileUrl ?? `${baseUrl}/effects/{operationId}`,
              shape: "found-flag",
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

export function writeRawActions(workspace: string, doc: unknown): void {
  mkdirSync(join(workspace, ".relay"), { recursive: true });
  writeFileSync(join(workspace, ".relay", "mcp-actions.json"), JSON.stringify(doc, null, 2));
}

export async function connectClient(workspace: string): Promise<McpClient> {
  const child = spawn(process.execPath, [MAIN, "--workspace", workspace], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: { isError?: boolean; text: string }) => void>();
  const exit = new Promise<{ status: number | null; signal: string | null }>((resolve) => {
    child.on("close", (status: number | null, signal: string | null) => resolve({ status, signal }));
  });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      const msg = JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve?.({
          isError: msg.result?.isError ?? false,
          text: msg.result?.content?.map((c) => c.text ?? "").join("") ?? "",
        });
      }
    } catch {
      // ignore non-JSON noise
    }
  });
  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<{ isError?: boolean; text: string }>((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ isError: true, text: `timeout waiting for ${method} #${id}` });
      }, 20_000);
    });

  const init = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  if (init.isError) throw new Error(`initialize failed: ${init.text}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  let nextId = 2;
  return {
    call: (name, args) => request(nextId++, "tools/call", { name, arguments: args }),
    kill: () => child.kill("SIGKILL"),
    exit,
  };
}

export async function readJournal(
  workspace: string,
  fn: (journal: SqliteEffectJournal) => Promise<EffectRecord[]>,
): Promise<EffectRecord[]> {
  const journal = await SqliteEffectJournal.open({ path: join(workspace, ".relay", "storage.db") });
  try {
    return await fn(journal);
  } finally {
    journal.close();
  }
}

export async function journalRecord(workspace: string, key: string): Promise<EffectRecord | undefined> {
  const journal = await SqliteEffectJournal.open({ path: join(workspace, ".relay", "storage.db") });
  try {
    return await journal.getByKey(key);
  } finally {
    journal.close();
  }
}

export async function journalStatus(workspace: string, key: string): Promise<string | undefined> {
  return (await journalRecord(workspace, key))?.status;
}
