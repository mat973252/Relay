#!/usr/bin/env node
/**
 * @relay/mcp — relay-mcp entry point.
 *
 * Usage: relay-mcp --workspace <dir>
 *
 * Requires <dir>/.relay/mcp-actions.json (schema relay.mcp-actions/1).
 * The server refuses to offer effect tools unless it owns the workspace's
 * single-writer lock.
 */
import { runStdioServer } from "./server.js";
import { ActionsConfigError } from "./actions.js";

function parseArgs(argv: string[]): { workspace: string } {
  let workspace = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        process.stderr.write("relay-mcp: --workspace requires a directory\n");
        process.exit(64);
      }
      workspace = value;
      i += 1;
    } else {
      process.stderr.write(`relay-mcp: unknown argument ${arg}\n`);
      process.exit(64);
    }
  }
  return { workspace };
}

const { workspace } = parseArgs(process.argv.slice(2));
try {
  await runStdioServer({ workspace });
} catch (err) {
  if (err instanceof ActionsConfigError) {
    process.stderr.write(`relay-mcp: ${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`relay-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(70);
}
