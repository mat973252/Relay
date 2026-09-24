/**
 * MCP vertical-slice tests: JSON-RPC handshake, single execution per
 * operation id, crash-after-remote-commit + restart + read-only reconcile
 * (counter stays 1), single-writer fail-closed behavior with lock takeover,
 * and fail-closed startup without an actions config.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { startMiniProvider } from "./fixtures/mini-provider.js";
import { SqliteEffectJournal } from "@relay/storage-sqlite";

const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "relay-mcp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

interface McpClient {
  call: (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  kill: () => void;
  exit: Promise<{ status: number | null; signal: string | null }>;
}

async function connectClient(workspace: string): Promise<McpClient> {
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
  const send = (id: number, method: string, params?: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<{ isError?: boolean; text: string }>((resolve) => {
      pending.set(id, resolve);
      send(id, method, params);
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

function writeActions(workspace: string, baseUrl: string): void {
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
            http: { url: `${baseUrl}/increment?operationId={operationId}`, method: "POST" },
            reconcile: { url: `${baseUrl}/effects/{operationId}`, shape: "found-flag" },
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function journalStatus(workspace: string, key: string): Promise<string | undefined> {
  const journal = await SqliteEffectJournal.open({ path: join(workspace, ".relay", "storage.db") });
  try {
    return (await journal.getByKey(key))?.status;
  } finally {
    journal.close();
  }
}

const OP = "demo-op-1";
const KEY = "counter-increment:demo-op-1";

describe("relay-mcp server", () => {
  it("handshakes, lists effect tools for the owner, and executes exactly once per operation id", async () => {
    const provider = await startMiniProvider();
    const workspace = mkdtempSync(join(tmp, "basic-"));
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const first = await client.call("relay_submit_action", { actionId: "counter-increment", operationId: OP });
      assert.equal(first.isError, false, first.text);
      const outcome = JSON.parse(first.text) as { status: string; deduplicated?: boolean };
      assert.equal(outcome.status, "confirmed");
      assert.equal(provider.counter(), 1);

      const second = await client.call("relay_submit_action", { actionId: "counter-increment", operationId: OP });
      const again = JSON.parse(second.text) as { status: string; deduplicated: boolean };
      assert.equal(again.status, "confirmed");
      assert.equal(again.deduplicated, true);
      assert.equal(provider.counter(), 1, "duplicate submission executed the remote action twice");

      const state = await client.call("relay_get_operation", { actionId: "counter-increment", operationId: OP });
      assert.match(state.text, /CONFIRMED/);
      const unresolved = await client.call("relay_list_unresolved", {});
      assert.match(unresolved.text, /no unresolved operations/);
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });

  it("dies after the remote commit, restarts, lists the unresolved id, reconciles read-only: counter stays 1", { timeout: 90_000 }, async () => {
    const provider = await startMiniProvider(5_000); // hold the response
    const workspace = mkdtempSync(join(tmp, "crash-"));
    writeActions(workspace, provider.baseUrl);
    const clientA = await connectClient(workspace);
    const submitted = clientA
      .call("relay_submit_action", { actionId: "counter-increment", operationId: OP })
      .catch(() => ({ isError: true, text: "client A died before answering" }));
    // Wait until the provider has committed the effect...
    const deadline = Date.now() + 10_000;
    while (!provider.found(OP) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(provider.found(OP), "provider never committed the action");
    clientA.kill(); // death before any local CONFIRMED
    await clientA.exit;
    await submitted;
    assert.equal(provider.counter(), 1);
    assert.equal(await journalStatus(workspace, KEY), "SUBMITTED");

    // Fresh server process (lock takeover after death), fresh "session".
    const clientB = await connectClient(workspace);
    try {
      const list = await clientB.call("relay_list_unresolved", {});
      assert.match(list.text, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(list.text, /SUBMITTED/);

      const reconciled = await clientB.call("relay_reconcile_operation", {
        actionId: "counter-increment",
        operationId: OP,
      });
      assert.equal(reconciled.isError, false, reconciled.text);
      const outcome = JSON.parse(reconciled.text) as { status: string; reconciled: boolean };
      assert.equal(outcome.status, "confirmed");
      assert.equal(outcome.reconciled, true);
      assert.equal(provider.counter(), 1, "reconciliation must be read-only");
      assert.equal(await journalStatus(workspace, KEY), "CONFIRMED");
    } finally {
      clientB.kill();
      await clientB.exit;
      await provider.stop();
    }
  });

  it("second live server fails closed; after the owner dies, a new server takes over", { timeout: 90_000 }, async () => {
    const provider = await startMiniProvider();
    const workspace = mkdtempSync(join(tmp, "dual-"));
    writeActions(workspace, provider.baseUrl);
    const owner = await connectClient(workspace);
    try {
      const second = await connectClient(workspace);
      const list = await second.call("relay_list_unresolved", {});
      // Fail-closed: no effect tools offered while the owner lives.
      const refused = await second.call("relay_submit_action", {
        actionId: "counter-increment",
        operationId: "never-happens",
      });
      assert.match(refused.text, /FAIL-CLOSED/);
      second.kill();
      await second.exit;
      assert.equal(provider.counter(), 0);
      assert.equal(await journalStatus(workspace, "counter-increment:never-happens"), undefined);

      // Owner still works.
      const ok = await owner.call("relay_submit_action", { actionId: "counter-increment", operationId: OP });
      assert.match(ok.text, /"status":"confirmed"/);
      assert.equal(provider.counter(), 1);
    } finally {
      owner.kill();
      await owner.exit;
    }

    // After the owner's death a new process takes the lock and can act.
    const successor = await connectClient(workspace);
    try {
      const state = await successor.call("relay_get_operation", { actionId: "counter-increment", operationId: OP });
      assert.match(state.text, /CONFIRMED/);
    } finally {
      successor.kill();
      await successor.exit;
      await provider.stop();
    }
  });

  it("refuses to start without an actions config (exit 78)", async () => {
    const workspace = mkdtempSync(join(tmp, "noconfig-"));
    const result = await new Promise<{ status: number | null }>((resolve) => {
      const child = spawn(process.execPath, [MAIN, "--workspace", workspace], { stdio: "ignore" });
      child.on("close", (status) => resolve({ status }));
    });
    assert.equal(result.status, 78);
  });

  it("rejects unknown actions and empty operation ids", async () => {
    const provider = await startMiniProvider();
    const workspace = mkdtempSync(join(tmp, "args-"));
    writeActions(workspace, provider.baseUrl);
    const client = await connectClient(workspace);
    try {
      const bogus = await client.call("relay_submit_action", { actionId: "not-configured", operationId: OP });
      assert.equal(bogus.isError, true);
      assert.match(bogus.text, /unknown actionId/);
      const empty = await client.call("relay_submit_action", { actionId: "counter-increment", operationId: "" });
      assert.equal(empty.isError, true);
      assert.match(empty.text, /operationId/);
      assert.equal(provider.counter(), 0);
    } finally {
      client.kill();
      await client.exit;
      await provider.stop();
    }
  });
});
