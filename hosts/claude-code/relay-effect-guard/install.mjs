#!/usr/bin/env node
/**
 * Generates hosts/claude-code/relay-effect-guard/.mcp.json for THIS machine
 * (absolute paths cannot travel inside a plugin template) and prints the
 * installation steps.
 *
 * Usage: node hosts/claude-code/relay-effect-guard/install.mjs [workspace]
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const pluginDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(pluginDir, "../../..");
const workspace = resolve(process.argv[2] ?? repoRoot);
const mcpMain = resolve(repoRoot, "packages/mcp/dist/src/main.js");

const config = {
  mcpServers: {
    relay: {
      command: process.execPath,
      args: [mcpMain, "--workspace", workspace],
      env: {},
    },
  },
};

const target = new URL(".mcp.json", `${pluginDir}/`).href;
await writeFile(fileURLToPath(target), `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${fileURLToPath(target)}`);
console.log(`workspace: ${workspace}`);
console.log(`server:    ${mcpMain}`);
console.log(`
Next steps (local verification):
  claude -p "call relay_list_unresolved and report the JSON" \\
    --mcp-config ${fileURLToPath(target)} --strict-mcp-config \\
    --allowedTools 'mcp__relay__relay_list_unresolved'

Plugin installation into a profile uses Claude Code's plugin/marketplace
mechanism; this template keeps the MCP registration identical to the one
verified above.`);
