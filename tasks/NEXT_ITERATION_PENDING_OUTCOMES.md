# MCP pending outcomes — safety repair before Step 6/7

Date: 2026-09-25. Starting commit: `e49d5ad02845fa7ea3f7d747439e7338b6989202`.
This stage is limited to the two independently reproduced provider outcome bugs below. Do not start Step 6/7, add AgentLens event adapters, publish packages, or call a real external provider.

## Reproduced failures

1. An ambiguous submit leaves the journal `UNKNOWN`. A read-only reconcile GET returning HTTP 200 with `{"status":"pending"}` is interpreted as `found:false` by `packages/mcp/src/server.ts`, then `packages/core/src/effect.ts` changes the journal to terminal `FAILED`. `pending` does not prove that the remote effect did not happen.
2. A submit POST returning HTTP 202 with `{"status":"pending"}` is interpreted as executed, and the journal becomes `CONFIRMED` even though the provider has only accepted work. A local fake provider committed no effect in the reproduction.

Both failures were reproduced on 2026-09-25 with a `127.0.0.1` fake provider and a disposable SQLite workspace. The independent review is in `reports/INDEPENDENT_SAFETY_REVIEW_2026-09-25.md`. Existing `reports/MCP_SAFETY_REVIEW_RESULT.md` describes an earlier internal pass; its 144 tests do not cover these cases.

## Work and acceptance

1. Inspect the current `status-field` contract in `packages/mcp/src/actions.ts`, submit/reconcile mapping in `packages/mcp/src/server.ts`, and state transitions in `packages/core/src/effect.ts`. Write deterministic regression tests that fail at this commit for both cases. Cover pending, unknown/missing/malformed reconcile statuses and an explicit, contract-backed proof of non-execution. A read-only reconcile must not submit an effect.
2. Implement the smallest fail-closed fix. An accepted or still-processing result must remain unresolved; only definitive execution may become `CONFIRMED`, and only a proven rejection/non-execution may become `FAILED`. Do not silently resubmit an `UNKNOWN` operation. Preserve existing synchronous-completion behavior where the contract actually proves it.
3. Run typecheck, full unit/integration tests, crash demo, and deterministic two-process lock regression. Run Node 22 and 24 where available. Record exact commands, environment, results, and remaining limits in a dated report. No real provider calls.
4. Commit and push only the repair branch, create a PR against `main`, and stop for independent Codex review. Do not merge it or claim Step 6/7 passed.

If the configured provider protocol lacks a sound way to distinguish accepted/pending/completed/rejected outcomes, document that limit and keep the operation unresolved instead of inventing a terminal state.
