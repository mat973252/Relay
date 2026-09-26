/** Synthetic report-export business, in a separate process with durable state.
 * Fault controls use parent IPC, never the business API exposed to the model.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const EXPECTED_CSV = "order_id,amount_cents\norder-101,1200\norder-102,3400\norder-103,5600\n";
export type Fault = "accepted" | "disconnect" | "hold" | "reject";

export async function startReportProvider(root: string, fault: Fault = "accepted", port = 0) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", root, fault, String(port)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("report provider startup timeout")); }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("report provider exited before ready")); });
    child.on("message", (message: { ready?: string }) => {
      if (message.ready) { clearTimeout(timer); resolve(message.ready); }
    });
  });
  return {
    baseUrl,
    pid: child.pid,
    control: (command: "visible" | "release") => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`provider control timeout: ${command}`)), 5_000);
      const handler = (message: { done?: string }) => {
        if (message.done === command) { clearTimeout(timer); child.off("message", handler); resolve(); }
      };
      child.on("message", handler);
      child.send({ command });
    }),
    stop: async () => { child.kill("SIGKILL"); await exit; },
  };
}

export function reportSnapshot(root: string) {
  const db = new DatabaseSync(join(root, "business.db"), { readOnly: true });
  try {
    return {
      jobs: db.prepare("SELECT operation_id, status, digest FROM jobs ORDER BY operation_id").all(),
      requests: db.prepare("SELECT method, operation_id FROM requests ORDER BY rowid").all(),
    };
  } finally { db.close(); }
}

async function serve(root: string, fault: Fault, port: number) {
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const db = new DatabaseSync(join(root, "business.db"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL);
    INSERT OR IGNORE INTO orders VALUES ('order-101',1200),('order-102',3400),('order-103',5600);
    CREATE TABLE IF NOT EXISTS jobs(operation_id TEXT PRIMARY KEY, status TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0, digest TEXT);
    CREATE TABLE IF NOT EXISTS requests(method TEXT NOT NULL, operation_id TEXT NOT NULL);`);
  const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sandbox");
    const match = /^\/exports\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!match) { json(res, 404, { status: "not_visible" }); return; }
    const id = match[1]!;
    db.prepare("INSERT INTO requests VALUES (?,?)").run(req.method ?? "", id);
    if (req.method === "POST") {
      if (fault === "reject") { json(res, 422, { status: "rejected" }); return; }
      db.prepare("INSERT OR IGNORE INTO jobs(operation_id,status) VALUES (?,'pending')").run(id);
      if (fault === "disconnect") { req.socket.destroy(); return; }
      if (fault === "hold") return; // parent kills Relay inside this commit/response gap
      json(res, 202, { status: "pending", operationId: id }); return;
    }
    if (req.method === "GET") {
      const row = db.prepare("SELECT status,visible,digest FROM jobs WHERE operation_id=?").get(id);
      if (!row || !row.visible) { json(res, 200, { status: "not_visible" }); return; }
      if (row.status !== "complete") { json(res, 200, { status: "pending" }); return; }
      const bytes = readFileSync(join(root, "artifacts", `${id}.csv`));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== row.digest) { json(res, 503, { status: "unverifiable" }); return; }
      json(res, 200, { status: "complete", operationId: id, artifact: `${id}.csv`, sha256: digest }); return;
    }
    json(res, 405, { status: "unsupported" });
  });
  // Background worker in this provider process; released survives a restart.
  setInterval(() => {
    const rows = db.prepare("SELECT operation_id FROM jobs WHERE status='pending' AND released=1").all();
    for (const job of rows) {
      const orders = db.prepare("SELECT id,amount_cents FROM orders ORDER BY id").all();
      const csv = "order_id,amount_cents\n" + orders.map((row) => `${String(row.id)},${String(row.amount_cents)}\n`).join("");
      const path = join(root, "artifacts", `${String(job.operation_id)}.csv`);
      writeFileSync(`${path}.tmp`, csv);
      renameSync(`${path}.tmp`, path);
      db.prepare("UPDATE jobs SET status='complete',digest=? WHERE operation_id=?")
        .run(createHash("sha256").update(csv).digest("hex"), job.operation_id!);
    }
  }, 25);
  process.on("message", (message: { command?: string }) => {
    if (message.command === "visible") db.exec("UPDATE jobs SET visible=1");
    if (message.command === "release") db.exec("UPDATE jobs SET released=1");
    process.send?.({ done: message.command });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  process.send?.({ ready: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` });
}

if (process.argv[2] === "serve") {
  await serve(process.argv[3]!, process.argv[4] as Fault, Number(process.argv[5]));
}
