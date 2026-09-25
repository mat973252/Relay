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
command = "wsl.exe"
args = ["-e", "node", "/mnt/d/code/aiproject/Relay/packages/mcp/dist/src/main.js", "--workspace", "/mnt/d/relay-workspace"]
'@ | Set-Content "$codexHome\config.toml"
Copy-Item "$env:USERPROFILE\.codex\auth.json" "$codexHome\auth.json" -ErrorAction Stop
$env:CODEX_HOME = $codexHome
codex exec --skip-git-repo-check --approve-for-me -
```

Notes from the verified run (Codex 0.156.1 on Windows):

- `--approve-for-me` is REQUIRED for MCP calls in `exec` mode — without it
  every tool call is blocked with "approval policy is never" and nothing
  executes.
- The `wsl.exe` bridge is the verified shape for a Windows Codex + WSL-built
  workspace (Windows node cannot resolve WSL pnpm symlinks); the server and
  the provider then share the WSL network namespace. A same-OS setup uses
  `command = "node"` with the plain server path.
- The prompt goes via stdin (`-`) — multi-word prompts passed as one
  `cmd.exe` argument get split.

3. Read `SKILL.md` in this directory into the agent's instructions (or add it
   to the project AGENTS.md) so retries reuse operation ids.

## Coverage and bypasses (honest statement)

- Protected: actions executed through the `relay` MCP tools.
- NOT protected: raw curl/fetch, shell commands, built-in tools, or any other
  MCP server. A model's awareness of the relay tools does not intercept
  anything.
- One live Relay MCP process per workspace: a second one fails closed until
  the first exits (single-writer lock, recoverable after process death).
