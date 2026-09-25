# Independent MCP safety review — 2026-09-25

Reviewed commit: `e49d5ad02845fa7ea3f7d747439e7338b6989202`. Read-only source review and dynamic reproduction used only a `127.0.0.1` fake provider and disposable local workspace. No real remote effect was attempted. The safety gate before Step 6/7 remains closed.

## Blocking observations

- `packages/mcp/src/actions.ts` documents `status-field` completion as `body.status === "complete"`, but does not say that every other value proves non-execution. In `packages/mcp/src/server.ts`, a 2xx reconcile response with `{"status":"pending"}` maps to `found:false`; `packages/core/src/effect.ts` then turns `UNKNOWN` into terminal `FAILED`. Reproduction: ambiguous submit returned 409 and left `UNKNOWN`; read-only GET returned `200 {"status":"pending"}`; journal became `FAILED` even though the fake provider still considered the operation pending.
- In `packages/mcp/src/server.ts`, a submit response `202 {"status":"pending"}` is treated as successful execution; `packages/core/src/effect.ts` marks it `CONFIRMED`. The fake provider accepted but did not commit the effect. HTTP 202 alone is not proof of completion.

These are state-classification failures. A later remote commit could contradict a local `FAILED`, and an uncommitted operation is incorrectly recorded as `CONFIRMED`. The reproduction does not assert that a real service committed; it establishes the incorrect local transitions.

## Other boundaries checked

- The same-key queue and absent/PREPARED reconcile precheck are present in this commit. This review did not find a reproducible dual-owner path between Relay protocol participants; lock release still depends on a read-then-remove sequence if a non-protocol local writer interferes.
- `relay_effects` updates one latest-state row per semantic key. It has no append-only transition history or general Run/Step/Recovery event stream, and no verified stable Pi session association key. AgentLens must not infer missing events or label a reconstructed trace as production evidence.

## Required next review

Add regression-first coverage for both pending outcomes, repair conservative state classification, then independently rerun MCP safety tests, crash recovery, two-process locking, and platform checks. Keep Step 6/7 and real external effects stopped until those checks pass. AgentLens M8 remains unaccepted without a trustworthy event source.
