/**
 * Local counter provider for MCP tests: commits immediately, can hold the
 * response to open the dangerous crash window. Compatible with the
 * "found-flag" reconcile shape.
 */
import { createServer, type Server } from "node:http";

export interface MiniProvider {
  baseUrl: string;
  counter: () => number;
  found: (operationId: string) => boolean;
  stop: () => Promise<void>;
}

export async function startMiniProvider(holdMs = 0): Promise<MiniProvider> {
  let counter = 0;
  const effects = new Set<string>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://test");
    if (req.method === "POST" && url.pathname === "/increment") {
      const operationId = url.searchParams.get("operationId") ?? "";
      counter += 1; // commit BEFORE answering
      effects.add(operationId);
      const send = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, value: counter }));
      };
      if (holdMs > 0) setTimeout(send, holdMs);
      else send();
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
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
