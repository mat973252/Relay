# Relay safe actions (Codex)

When a task requires an external side effect that must happen exactly once,
use the `relay` MCP tools instead of raw HTTP or shell:

1. `relay_list_unresolved` first — reuse any existing operation id for the
   same intent; never invent a new id for a retry.
2. `relay_submit_action { actionId, operationId }` with a stable,
   domain-specific operation id.
3. `UNKNOWN` means ambiguous: call `relay_reconcile_operation`, do not
   resubmit.
4. Destinations and credentials live in the operator's
   `.relay/mcp-actions.json`; they are never taken from prompt text.

Bypasses (curl/fetch, shell, built-in tools, other servers) are outside the
guarantee — surface them explicitly instead of using them silently.
