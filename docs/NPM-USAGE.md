# npm installation and usage

Use Node 24 (or Node 22.13+). Install the CLI and MCP server:

```sh
npm install -g @mat973252/relay-cli@0.1.0 @mat973252/relay-mcp@0.1.0
relay --help
```

The commands are `relay` and `relay-mcp`. No build step, pnpm, model account or
Pi installation is required for MCP. `relay doctor` additionally checks for the
Pi CLI, so its missing-Pi result is expected when using only MCP.

## Configure one business action

Create `.relay/mcp-actions.json` in your business workspace. This example
assumes your service exposes the following two endpoints; Relay does not
create the service. Replace `http://127.0.0.1:8080` with your actual service.

```json
{
  "schema": "relay.mcp-actions/1",
  "actions": [{
    "id": "export-orders",
    "label": "Export monthly orders",
    "http": {
      "method": "POST",
      "url": "http://127.0.0.1:8080/exports/{operationId}"
    },
    "reconcile": {
      "url": "http://127.0.0.1:8080/exports/{operationId}",
      "shape": "status-field",
      "completeStatuses": ["complete"]
    }
  }]
}
```

POST submits the operation; GET must be read-only and query that same ID.
A 202 response or `{ "status": "pending" }` does not prove completion.
Only `{ "status": "complete" }` confirms this contract. Temporary absence,
timeouts and other unlisted results stay UNKNOWN. Do not list a failure status
as definitive non-execution unless the provider can prove that guarantee.
The current HTTP action substitutes the operation ID into the URL and sends
configured headers, without a request body. It is not an arbitrary request-body
proxy. Destinations and credentials are configured
by the operator, not supplied by the model.

## Connect a coding agent

For a same-OS Codex setup, add this to your Codex `config.toml`, using an
absolute workspace path (the example is Windows):

```toml
[mcp_servers.relay]
command = "relay-mcp"
args = ["--workspace", "D:/work/orders"]
```

Claude Code's MCP JSON equivalent:

```json
{
  "mcpServers": {
    "relay": {
      "command": "relay-mcp",
      "args": ["--workspace", "D:/work/orders"]
    }
  }
}
```

The host must see the npm global bin directory on PATH. If it cannot execute
the Windows `.cmd` shim, use `command = "node"` and put the absolute installed
`@mat973252/relay-mcp/dist/src/main.js` path before `--workspace` in `args`.
`npm root -g` prints the directory containing that package. Restart the host
after changing its MCP configuration. The server speaks stdio; running it in
a terminal alone waits for MCP input and does not open a UI.

Tell the agent:

> Use Relay for the September order export. First call relay_list_unresolved.
> Reuse an existing operation for this intent; otherwise submit export-orders
> with operationId monthly-orders-202609. If the result is UNKNOWN, only call
> relay_reconcile_operation for that same ID. Never create another ID to retry.

The core sequence is:

1. `relay_list_unresolved {}`
2. `relay_submit_action {"actionId":"export-orders","operationId":"monthly-orders-202609"}`
3. If UNKNOWN: `relay_reconcile_operation {"actionId":"export-orders","operationId":"monthly-orders-202609"}`

From the workspace directory, inspect the recorded outcome:

```sh
relay effects --history
relay status
```

Only actions executed through Relay are protected. Raw HTTP/shell calls bypass
it. Only one live MCP server may own a workspace. Keep the workspace and
operation ID stable across agent restarts. Review caller-owned capsule data for
secrets before exporting or sharing it.

## Pi and libraries

The optional Pi package is `@mat973252/relay-adapter-pi@0.1.0`; it declares its
extension in `package.json` and was tested with Pi 0.87.0. Library packages are
`relay-core`, `relay-storage-sqlite`, `relay-artifact-fs` and `relay-epistemic`
under the same scope. Internal `@relay/*` dependency keys are npm aliases to
these published packages, not dependencies on somebody else's npm scope.

For the model-free crash demo and synthetic business sandbox, use the
[source quickstart](../README.md#the-one-sitting-proof-no-pi-no-model-account-no-docker).
