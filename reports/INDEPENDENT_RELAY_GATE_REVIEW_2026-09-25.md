# Relay gate review after pending and Windows fence repairs

Date: 2026-09-25. Reviewed `main` at `3a89f0299ec7192eac5296a81551b979097a1b31`. This is a source and isolated-test review, not an authorization for production effects.

## What the evidence now supports

- The pending-outcome repair from PR #1 keeps `202`/`pending` and unresolved reconcile results at `UNKNOWN`; contract-proven completion or non-execution alone settles the effect. The MCP tests cover the earlier `409 -> UNKNOWN -> GET pending` and `POST 202 pending` counterexamples, same-key serialization, and read-only reconcile.
- The Windows fence repair from PR #2 removes rename-replace of claim paths and uses exclusive hard-link claim levels. Native Windows Node 24.13 targeted lock tests passed 16/16 twice and the MCP suite passed 46/46. WSL Ubuntu Node 22.18 and 24.4 full workspace suites and crash demo passed. See `INDEPENDENT_WINDOWS_FENCE_ACCEPTANCE_2026-09-25.md` for the commands and Windows harness limits.
- The effect runner still treats ambiguous execution as `UNKNOWN` and requires reconciliation before any unsafe retry. These are local, fake-provider results only. No real external provider contract or credential boundary was tested.

## Remaining safety and evidence boundaries

- For a configured `found-flag` action, a synchronous 2xx submit is treated as completed. This is safe only if that provider contract makes 2xx proof of execution. A provider returning 2xx for mere acceptance must use a different contract; do not infer safety from HTTP status alone. Verify the actual provider contract before any real effect.
- The lock serializes protocol participants on one local machine. A non-protocol local writer can replace the lock between read and rename, or between the old owner's read and release; the filesystem code has no atomic compare-and-delete for such interference. Treat the workspace and lock directory as a trusted boundary. The current release/takeover tests do not prove safety against arbitrary local writers.
- The litter sweep can remove another process's in-flight uniquely named temporary file. That process should fail closed, but this is a liveness limit, not a demonstrated duplicate-effect path. Permanent `mcp-owner.claim.*` files are not swept.
- Windows workspace-wide tests still stop at a pre-existing path-separator assertion, and the standalone crash demo assumes POSIX `SIGKILL`. They are not passing Windows-wide evidence. No hosted CI is configured for Relay.
- The SQLite effect journal stores the latest row per key, not an append-only transition history or Run/Step/Recovery stream. There is no verified stable association between a Relay effect and a Pi session/tool entry. AgentLens M8 therefore remains unaccepted; a final `CONFIRMED` row must not be narrated as a known recovery sequence.

## Gate decision

The two reproduced defects have been repaired and independently checked. The **overall Relay safety gate remains closed** until a concrete provider's completion/reconcile contract and trusted workspace boundary are verified, and the relevant Windows/CI evidence is complete. Do not run real external effects or claim Step 6/7 passed. The AgentLens M8 data-source gate is separately blocked by missing event history and association evidence.
