# Next stage: truthful Relay effect transition evidence

Date: 2026-09-25. Start from current Relay `main` after PR #2 and read `AGENTS.md`, `docs/ARCHITECTURE.md`, `reports/INDEPENDENT_RELAY_GATE_REVIEW_2026-09-25.md`, and AgentLens `docs/m8-relay-dogfood.md` first. This is one bounded Devin coding stage, hard ceiling **10 ACU**. Stop at the ceiling or if the persistence contract cannot be made safe. Work on `devin/effect-evidence-history`; create a PR against `main`, then stop without merging.

## Goal

Provide a durable, append-only record of **actually committed Relay effect state transitions and explicit reconcile observations**, so an isolated consumer can distinguish observed history from a latest-state snapshot. Keep Relay's existing latest-state `relay_effects` behavior and unsafe-effect safety semantics unchanged. This is Relay-owned effect evidence, not a second Pi session store and not a claim of complete Run/Step/Recovery coverage.

## Scope and invariants

1. First inspect the current journal schema, transition call sites, SQLite transaction boundaries, capsule export/import, and public Pi APIs relevant to stable session/tool association. Write tests before changing behavior. If an atomic history write cannot accompany a status transition, report the blocker and stop; do not make a best-effort history that could lie after a crash.
2. Add the smallest append-only event schema and read-only listing API needed to record state transition, cause (`prepare`, `submit`, `execute`, `reconcile`, or explicit unknown), timestamp, and stable effect key/operation identity. Record only facts Relay actually observes. Do not persist secrets, model prose, raw request bodies, credentials, or fabricated Run/Step events. The latest-state row remains authoritative for execution decisions.
3. For existing databases, do not backfill imaginary transitions. A legacy effect may expose only a clearly labeled current-state snapshot with history unavailable. Schema migration must be safe on repeated open and on crash. Preserve existing capsule integrity and import behavior; if a capsule includes the new evidence, validate it without accepting forged completion as execution authority.
4. Test the dangerous windows: `PREPARED`, `SUBMITTED`, crash after remote commit, `UNKNOWN`, read-only reconcile to `CONFIRMED`/`FAILED`, repeated reconcile, same-key concurrency, restart, and legacy database. Compare stored event order with actual fake-provider observations. No duplicate transition from retry, no invented recovery event, no status/history contradiction after injected crash.
5. Investigate whether a stable Pi session/tool reference can be captured using public APIs for actions **actually invoked through the Pi adapter**. Add such a reference only if proven stable and non-secret, and label absence explicitly. Never correlate an MCP effect to a Pi session by directory, time proximity, or a guessed matching string. If unavailable, document that M8's full Run/Step association remains blocked.

## Verification and stop

Use disposable local workspaces and loopback fake providers only. No real external effect, Step 6/7, npm publication, or AgentLens product change. Run frozen install, typecheck, targeted history/crash/reconcile tests, full MCP and workspace tests on available Node 22/24; distinguish Linux evidence from native Windows. Produce a result report with exact commands, counts, migration behavior, source references, and remaining limits. Push only the stage branch, open a PR, and stop for independent Codex review. This stage alone does not clear Relay's safety gate or AgentLens M8.
