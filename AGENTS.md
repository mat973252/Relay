# Relay — Instructions for Pi

You are implementing **Relay**, a durable execution-continuity layer whose first adapter targets Pi AgentHarness.

## Non-negotiable architecture boundary

Do NOT reimplement:
- Pi agent loop
- Pi session tree
- Pi suspended run semantics
- Pi DeferredHandle
- Pi resume semantics
- Pi tool replay semantics

Use Pi's native public extension/SDK/harness APIs wherever possible.

Relay owns only:
- external effect journal + reconciliation
- artifact registry + lineage
- capability contract + doctor
- capsule export/import
- migration evidence and integrity validation

## Implementation language

- TypeScript only for v0.1
- strict ESM
- Node 22+ compatible
- test on Node 22 and 24
- SQLite through a low-friction Node-compatible implementation; prefer built-in `node:sqlite` if supported by the runtime matrix
- SHA-256 through `node:crypto`
- YAML only for human-authored capability config
- JSON for machine manifests

## Engineering constraints

1. No Pi fork.
2. No LangChain/LangGraph.
3. No Temporal.
4. No Redis/Postgres/Kafka.
5. No Docker requirement for v0.1.
6. No web UI.
7. No multi-agent.
8. No model router/JEV in v0.1.
9. No hidden automatic retries for UNKNOWN unsafe effects.
10. Secrets must never be serialized into capsules, SQLite rows, artifacts, manifests, or logs.

## Required workflow

For each milestone:
1. Read the relevant task file under `tasks/`.
2. Inspect current Pi APIs before coding. Do not assume old API names.
3. Write/adjust tests first for the milestone's key invariant.
4. Implement the smallest code that passes.
5. Run typecheck + unit + integration tests.
6. Produce `reports/MX_RESULT.md` with:
   - implemented behavior
   - API decisions
   - tests run
   - failures/limitations
   - files changed
   - next milestone blockers
7. Commit only after milestone tests pass.

Do not continue to the next milestone if the current milestone gate fails.

## Persistent-state invariants

- **Derived, never narrated.** Persist evidence (events, artifacts, real command results), never recomputable prose such as progress percentages, code summaries, or test claims.
- **No documentation duplication.** Do not create natural-language mirrors of the source tree. Persist only intent, invariants, decisions/tradeoffs, and real test evidence.
- **Persistent Context has a budget.** Do not build project-wide spec/context loading systems.
- **No Delta, No Attention** is reserved for the epistemic stage (Delta entity comes first; no attention queues before it exists).

## Primary invariant

The worst failure is not a crash. The worst failure is a crash followed by an invisible duplicate side effect.

When in doubt, preserve an `UNKNOWN` state and require reconciliation instead of retrying blindly.
