/**
 * Local counter provider for MCP tests: commits immediately, can hold the
 * response to open the dangerous crash window, can commit-then-answer with
 * an error status (the ambiguous-provider case), or never answer at all
 * (the bounded-timeout case). Records every request for read-only checks.
 * Compatible with the "found-flag" reconcile shape.
 */
import { createServer, type Server } from "node:http";

export interface MiniProviderOptions {
  /** Commit first, then hold the response this long before answering 200. */
  holdMs?: number;
  /** Hold this long BEFORE committing (the in-flight false-failure window). */
  preCommitHoldMs?: number;
  /** Commit, then answer POSTs with this HTTP status instead of 200. */
  commitStatus?: number;
  /** Accept POSTs but never answer them (bounded-timeout case). */
  neverRespond?: boolean;
}

export interface MiniProvider {
  baseUrl: string;
  counter: () => number;
  found: (operationId: string) => boolean;
  /** Every request the provider saw, as "METHOD path". */
  requests: () => string[];
  stop: () => Promise<void>;
}

export async function startMiniProvider(options: MiniProviderOptions = {}): Promise<MiniProvider> {
  const holdMs = options.holdMs ?? 0;
  const preCommitHoldMs = options.preCommitHoldMs ?? 0;
  let counter = 0;
  const effects = new Set<string>();
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://test");
    seen.push(`${req.method ?? "?"} ${url.pathname}`);
    if (req.method === "POST" && url.pathname === "/increment") {
      const operationId = url.searchParams.get("operationId") ?? "";
      if (options.neverRespond === true) return; // socket stays open, no answer
      const commit = () => {
        counter += 1; // commit BEFORE answering
        effects.add(operationId);
        const send = () => {
          if (options.commitStatus !== undefined) {
            res.writeHead(options.commitStatus, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `committed but answering ${String(options.commitStatus)}` }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, value: counter }));
        };
        if (holdMs > 0) setTimeout(send, holdMs);
        else send();
      };
      if (preCommitHoldMs > 0) setTimeout(commit, preCommitHoldMs);
      else commit();
      return;
    }
    const m = url.pathname.match(/^\/effects\/(.+)$/);
    if (req.method === "GET" && m) {
      const found = effects.has(decodeURIComponent(m[1] ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ found }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ counter }));
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
    found: (operationId) => effects.has(operationId),
    requests: () => [...seen],
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
