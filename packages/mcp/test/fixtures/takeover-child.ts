/**
 * Takeover-race child: waits for a barrier file, then attempts workspace
 * ownership takeover once and reports the result as one JSON line on stdout.
 * Stays alive afterwards so that pid-liveness checks in the OTHER child see
 * a live owner (killed by the parent after evidence collection).
 *
 * Usage: takeover-child.js <relayDir> <barrierFile>
 */
import { statSync } from "node:fs";
import { takeWorkspaceOwnership } from "../../src/index.js";

const [, , relayDir, barrierFile] = process.argv;
if (relayDir === undefined || barrierFile === undefined) {
  process.stderr.write("usage: takeover-child.js <relayDir> <barrierFile>\n");
  process.exit(64);
}

// Barrier: wait until the parent creates the file (max 10s).
const deadline = Date.now() + 10_000;
for (;;) {
  try {
    statSync(barrierFile);
    break;
  } catch {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ownership = await takeWorkspaceOwnership(relayDir);
process.stdout.write(`${JSON.stringify({ kind: ownership.kind, pid: process.pid, owner: ownership.owner })}\n`);

// Keep the process (and, if acquired, the live lock) alive for inspection.
await new Promise((resolve) => setTimeout(resolve, 8_000));
process.exit(0);
