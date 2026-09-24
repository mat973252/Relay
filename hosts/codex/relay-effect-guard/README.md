# relay-effect-guard (Codex host entry)

Registers the SAME local Relay MCP server (`packages/mcp`) that Claude Code
and Pi use. The server exposes only explicitly configured actions
(`<workspace>/.relay/mcp-actions.json`); destinations and credentials never
come from model text.

## Install (per machine — Windows example, adjust paths)

1. Build the workspace: `corepack pnpm install && corepack pnpm typecheck`.
2. Generate a CODEX_HOME config for a clean profile:

```powershell
$codexHome = "$env:TEMP\relay-codex-home"
New-Item -ItemType Directory -Force $codexHome | Out-Null
@'
[mcp_servers.relay]
command = "node"
args = ["D:\\code\\aiproject\\Relay\\packages\\mcp\\dist\\src\\main.js", "--workspace", "D:\\code\\aiproject\\Relay"]
'@ | Set-Content "$codexHome\\config.toml"
Copy-Item "$env:USERPROFILE\\.codex\\auth.json" "$codexHome\\auth.json" -ErrorAction Stop
$env:CODEX_HOME = $codexHome
codex exec "call relay_list_unresolved and report the JSON"
```

3. Read `SKILL.md` in this directory into the agent's instructions (or add it
   to the project AGENTS.md) so retries reuse operation ids.

## Coverage and bypasses (honest statement)

- Protected: actions executed through the `relay` MCP tools.
- NOT protected: raw curl/fetch, shell commands, built-in tools, or any other
  MCP server. A model's awareness of the relay tools does not intercept
  anything.
- One live Relay MCP process per workspace: a second one fails closed until
  the first exits (single-writer lock, recoverable after process death).
