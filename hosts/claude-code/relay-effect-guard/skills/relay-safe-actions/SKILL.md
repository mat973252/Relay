---
name: relay-safe-actions
description: Submit non-replayable external actions (HTTP side effects) through Relay so a crash can never silently duplicate them. Use when an action mutates an external system (invoices, deployments, messages, payments) instead of issuing raw HTTP/shell calls.
---

# Relay safe actions

When a task requires an external side effect that must happen exactly once:

1. Call `relay_list_unresolved` FIRST. If the intent already has an operation
   id listed there, REUSE it — never invent a new one for a retry.
2. Choose a stable, domain-specific `operationId` that would be reconstructible
   from the task itself (e.g. `invoice-import:2026-09-24-batch-017`).
3. Call `relay_submit_action` with `{ actionId, operationId }`.
   - `CONFIRMED` → done; the result payload is included.
   - `UNKNOWN` → the outcome is ambiguous. Do NOT resubmit. Call
     `relay_reconcile_operation` and act on its verdict.
   - `FAILED` → safe to reason about a NEW intent (new operationId) only
     after reading the failure reason.
4. Destinations and credentials are operator-configured
   (`.relay/mcp-actions.json`); they are never taken from prompt text.

What this does NOT cover: raw `curl`/fetch, shell commands, built-in tools,
or other MCP servers are outside Relay's guarantee. If a bypass path is the
only way to do something, say so instead of silently using it.
