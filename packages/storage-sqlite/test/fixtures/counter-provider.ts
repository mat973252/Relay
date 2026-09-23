/**
 * Local HTTP mock provider for M1 crash tests (parent side).
 *
 * Endpoints:
 *   POST /increment?key=K[&ackMs=N][&holdMs=N][&mode=idempotent]
 *     - marks the request as inflight immediately on receipt
 *     - waits ackMs (deterministic window to observe "request left client")
 *     - increments the durable counter and records the effect
 *     - waits holdMs before responding (deterministic window to observe
 *       "remote committed before local confirmation")
 *     - mode=idempotent replays the stored response for a known key without
 *       incrementing (models a provider idempotency-key contract)
 *   GET /effects/K  -> { found, remoteRef?, value? }
 *   GET /inflight?key=K -> { waiting }
 *   GET /state      -> { counter }
 */
import { createServer, type Server } from "node:http";

export interface CounterProvider {
  baseUrl: string;
  state: () => { counter: number };
  effect: (key: string) => { remoteRef: string; value: number } | undefined;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startCounterProvider(): Promise<CounterProvider> {
  let counter = 0;
  const effects = new Map<string, { remoteRef: string; value: number }>();
  const inflight = new Set<string>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void (async () => {
      if (req.method === "POST" && url.pathname === "/increment") {
        const key = url.searchParams.get("key") ?? "";
        const ackMs = Number(url.searchParams.get("ackMs") ?? "0");
        const holdMs = Number(url.searchParams.get("holdMs") ?? "0");
        const idempotent = url.searchParams.get("mode") === "idempotent";
        if (idempotent && effects.has(key)) {
          const stored = effects.get(key);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, key, remoteRef: stored?.remoteRef, value: stored?.value, deduplicated: true }));
          return;
        }
        inflight.add(key);
        if (ackMs > 0) await sleep(ackMs);
        counter += 1;
        const record = { remoteRef: `fx-${counter}`, value: counter };
        effects.set(key, record);
        inflight.delete(key);
        if (holdMs > 0) await sleep(holdMs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, key, remoteRef: record.remoteRef, value: record.value }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ counter }));
        return;
      }
      const inflightMatch = url.pathname.match(/^\/inflight$/);
      if (req.method === "GET" && inflightMatch !== null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ waiting: inflight.has(url.searchParams.get("key") ?? "") }));
        return;
      }
      const effectMatch = url.pathname.match(/^\/effects\/(.+)$/);
      if (req.method === "GET" && effectMatch !== null) {
        const key = decodeURIComponent(effectMatch[1] ?? "");
        const record = effects.get(key);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          record === undefined
            ? JSON.stringify({ found: false })
            : JSON.stringify({ found: true, remoteRef: record.remoteRef, value: record.value }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state: () => ({ counter }),
    effect: (key) => effects.get(key),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
