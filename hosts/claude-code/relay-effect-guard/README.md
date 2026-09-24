# relay-effect-guard (Claude Code host entry)

Registers the local Relay MCP server (`packages/mcp`) with Claude Code.
The server exposes only explicitly configured actions
(`<workspace>/.relay/mcp-actions.json`, schema `relay.mcp-actions/1`);
destinations and credentials never come from prompt text.

## Install (local verification)

```bash
node hosts/claude-code/relay-effect-guard/install.mjs [workspace]
```

This generates `.mcp.json` with absolute paths for THIS machine. Verify the
exact server command headlessly before installing anything:

```bash
claude -p "call relay_list_unresolved and report the JSON" \
  --mcp-config hosts/claude-code/relay-effect-guard/.mcp.json \
  --strict-mcp-config --allowedTools 'mcp__relay__relay_list_unresolved'
```

The plugin layout (`.claude-plugin/plugin.json`, `.mcp.json`,
`skills/relay-safe-actions/SKILL.md`) follows the Claude Code plugin shape;
installation into a real profile goes through Claude Code's plugin /
marketplace mechanism after local verification passes.

## Coverage and bypasses (honest statement)

- Protected: actions executed through the `relay` MCP tools.
- NOT protected: raw curl/fetch, shell commands, built-in tools (Bash/WebFetch
  included), or other MCP servers. Installing this plugin intercepts
  nothing; the safe path is the skill + tool contract above.
- One live Relay MCP process per workspace: a second one fails closed until
  the first exits (single-writer lock, recoverable after process death).
