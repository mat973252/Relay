# M1 Result — External Effect Guard

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- `runEffect(input)` in `@relay/core` implements the `relay.effect({ key, kind, request, replay, execute, reconcile })` semantic contract as a pure orchestrator over an injected durable `EffectJournal`:
  - Fresh path: `PREPARED → SUBMITTED → execute → CONFIRMED | FAILED | UNKNOWN`.
  - Re-entry: `CONFIRMED` → deduplicated result (no execution); `PREPARED` → safe continuation (execution provably never began); `SUBMITTED | UNKNOWN` → reconcile required (`found → CONFIRMED`, `not-found → FAILED` with evidence, `uncertain → stays UNKNOWN`); `FAILED` → terminal.
  - No reconcile supplied on an unsettled record → `EffectNeedsReconciliationError`; automatic replay never happens for `replay: "never"` (the only supported policy in v0.1; others are rejected).
- `EffectRecord` persisted fields: id (uuid), semantic key (UNIQUE), kind, SHA-256 request hash (canonicalized, key-order independent), replay policy, status, remoteRef, result JSON, transition reason, createdAt/submittedAt/settledAt/updatedAt.
- `SqliteEffectJournal` (`@relay/storage-sqlite`): `node:sqlite`, WAL + `synchronous=FULL`, status CHECK constraint, one row per semantic key. Commits are synchronous statement completions, so a SIGKILL between statements never loses a committed transition.
- Crash-injection seams: runner-level points (`before-prepared-commit`, `after-prepared-commit`, `before-execute`, `after-execute-before-confirm`, `after-confirm`) through `input.crash`; in-flight points (`after-send`, `after-remote-commit`) inside the provider-facing `execute` of the test fixture, driven by observable provider markers so they are deterministic, not timing races.
- Mock HTTP counter provider (test fixture): `POST /increment` (durable counter; `ackMs` = observable request-receipt window; `holdMs` = committed-but-unresponded window; `mode=idempotent` = provider idempotency-key contract), `GET /effects/:key`, `GET /inflight?key=`, `GET /state`.

## API decisions

- `AmbiguousEffectError` thrown by `execute` maps to `UNKNOWN`; all other errors are definitive `FAILED`. The caller (adapter, later Pi tool wrap) classifies ambiguity — Relay does not guess.
- `reconcile` is read-only observation, never replay. `not-found` on `SUBMITTED/UNKNOWN` is `FAILED` (operator re-issues under a new decision) even when the provider claims authoritative absence: strictness is chosen because the worst failure is an invisible duplicate, not a missed execution. `PREPARED` re-entry may continue to execute because PREPARED is committed strictly before `execute` is ever invoked.
- One journal row per semantic key: re-entry semantics are keyed lookup, not append history. (Append-only event log remains a v0.2 option if audit history is required.)
- `SimulatedProcessDeath` (in-process unit seam) and real SIGKILL (child-process seam) share the same crash-point vocabulary.

## Tests run (real commands, real results)

`corepack pnpm check` = root `tsc -b` + all package tests. Totals: **58 pass, 0 fail** (core 31, storage-sqlite 15, artifact-fs 2, cli 5, adapter-pi 5).

Key suites:

- core/effect.test.ts — hashing determinism; fresh path; dedup after CONFIRMED; definitive/ambiguous failure mapping; UNKNOWN blocks re-entry without reconcile; all three reconcile outcomes; PREPARED continuation; crash-at-point status table for all runner points (unit seam).
- storage-sqlite/journal.test.ts — reopen durability; every status transition with timestamps/evidence; duplicate-key rejection. (Caught a real parameter-count bug in `markUnknown` before any integration run.)
- storage-sqlite/crash-matrix.test.ts — **real child processes SIGKILLed at every required boundary**, each scenario asserting journal status after crash, provider counter after crash, restart outcome, final status, and counter ≤ 1:

| # | Crash point | Status after crash | Counter after crash | Restart result | Final counter |
|---|---|---|---|---|---|
| 1 | before PREPARED commit | — | 0 | fresh run → CONFIRMED | 1 |
| 2 | after PREPARED commit | PREPARED | 0 | safe continuation → CONFIRMED | 1 |
| 3 | immediately before POST | SUBMITTED | 0 | reconcile not-found → FAILED | 0 |
| 4 | after request leaves client | SUBMITTED | 1 | reconcile found → CONFIRMED | 1 |
| 5 | after remote commit, before response | SUBMITTED | 1 | reconcile found → CONFIRMED | 1 |
| 6 | after response, before CONFIRMED commit | SUBMITTED | 1 | reconcile found → CONFIRMED | 1 |
| 7 | after CONFIRMED commit | CONFIRMED | 1 | dedup (no execution) | 1 |

  Plus: repeated restarts (×3) never duplicate a confirmed effect (T21 analog); idempotent provider mode replays stored response without a second increment (T08).

## Failures / limitations (fixed during the milestone)

- Parent-side `spawnSync` deadlocked the in-process mock provider against the child's HTTP calls (blocked event loop). The matrix now uses async `spawn`; documented in the test.
- Scenario 5's provider holds the increment response 8 s; the provider's `stop()` force-closes connections so the suite stays fast.
- In-flight crash points depend on provider markers (`/inflight`, `/effects`) for determinism — real providers will need equivalent observability for reconciliation, which is exactly the provider contract Relay requires.

## Files changed

- `packages/core/src/effect.ts` (new), exported from `packages/core/src/index.ts`.
- `packages/storage-sqlite/src/journal.ts` (new), exported from `packages/storage-sqlite/src/index.ts`.
- Tests: `packages/core/test/effect.test.ts`, `packages/storage-sqlite/test/journal.test.ts`, `packages/storage-sqlite/test/crash-matrix.test.ts`, fixtures `packages/storage-sqlite/test/fixtures/counter-provider.ts`, `packages/storage-sqlite/test/fixtures/effect-child.ts`.

## Gate check

- "A single logical unsafe operation never increments the mock remote counter twice silently" — **PASS** (all 7 crash boundaries + repeated-restart test).
- "Uncertain state remains UNKNOWN until reconciled" — **PASS** (unit: uncertain reconcile keeps UNKNOWN, blocks un-reconciled re-entry; matrix: SUBMITTED states settle only through reconcile).

## Next milestone blockers

None. M2 (Artifact Registry: CAS + lineage + `relay artifacts`/`relay lineage`) can start per `docs/ROADMAP.md`.
