/**
 * Async-outcome provider for pending-outcome regressions: POSTs are ACCEPTED
 * first (returning a configurable status/body) and committed only after
 * `commitAfterMs`, modelling providers whose submit response is not proof of
 * execution. GET /effects/{operationId} reports the remote state through the
 * "status-field" contract ("pending"/"complete"/"failed"), and the response
 * shape can be overridden to cover missing/malformed statuses.
 */
import { createServer, type Server } from "node:http";

export interface PendingProviderOptions {
  /** HTTP status answered on POST /increment (default 202). */
  submitStatus?: number;
  /** Body field `status` answered on POST /increment (default "pending"). */
  submitBodyStatus?: string;
  /** Accept first, commit this many ms later (default 0 = never commits). */
  commitAfterMs?: number;
  /** Override the body answered by GET /effects/{operationId}. */
  reconcileBody?: () => Record<string, unknown>;
}

export interface PendingProvider {
  baseUrl: string;
  counter: () => number;
  state: (operationId: string) => "pending" | "complete" | "failed";
  /** Every request the provider saw, as "METHOD path". */
  requests: () => string[];
  stop: () => Promise<void>;
}

export async function startPendingProvider(options: PendingProviderOptions = {}): Promise<PendingProvider> {
  const submitStatus = options.submitStatus ?? 202;
  const submitBodyStatus = options.submitBodyStatus ?? "pending";
  const commitAfterMs = options.commitAfterMs ?? 0;
  let counter = 0;
  const states = new Map<string, "pending" | "complete" | "failed">();
  const seen: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://test");
    seen.push(`${req.method ?? "?"} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/increment") {
      const operationId = url.searchParams.get("operationId") ?? "";
      const initial = submitStatus === 400 && submitBodyStatus === "failed" ? "failed" : "pending";
      states.set(operationId, initial);
      if (commitAfterMs > 0) {
        const timer = setTimeout(() => {
          if (states.get(operationId) === "pending") {
            states.set(operationId, "complete");
            counter += 1;
          }
        }, commitAfterMs);
        timers.add(timer);
      }
      res.writeHead(submitStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: submitBodyStatus }));
      return;
    }
    const m = url.pathname.match(/^\/effects\/(.+)$/);
    if (req.method === "GET" && m) {
      const operationId = decodeURIComponent(m[1] ?? "");
      const body = options.reconcileBody?.() ?? { status: states.get(operationId) ?? "failed" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    counter: () => counter,
    state: (operationId) => states.get(operationId) ?? "failed",
    requests: () => [...seen],
    stop: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
