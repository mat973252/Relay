# Effect evidence history stage result

Date: 2026-09-25. Branch `devin/effect-evidence-history`, based on `main` at
`3c18c394a0795301e7bc0758934b8874dea4a333`. Scope is the task document
`tasks/NEXT_ITERATION_EFFECT_EVIDENCE_HISTORY.md` only. This is Linux,
fake-provider (`127.0.0.1`) evidence; it is not an overall Relay safety-gate
acceptance, not an AgentLens change, and not a Pi Run/Step/Recovery store.

## Behavior implemented

- New append-only table `relay_effect_events` in `@relay/storage-sqlite`
  (`packages/storage-sqlite/src/journal.ts`): `seq` (AUTOINCREMENT), `effect_id`
  (FK to `relay_effects.id`), `key`, `kind`, `from_status` (NULL for the initial
  insert), `to_status`, `cause`, `reason`, `remote_ref`, `at`, with CHECK
  constraints on status and cause values and an index on `(effect_id, seq)`.
- Every mutation (`insertPrepared`, `markSubmitted`, `markConfirmed`,
  `markFailed`, `markUnknown`) updates the latest-state row and appends its event
  inside one `BEGIN IMMEDIATE ... COMMIT` transaction. Invalid transitions throw
  and roll back with no event appended. Deduplicated re-entry into a terminal
  `CONFIRMED`/`FAILED` (same status, same remote ref) appends nothing. Repeated
  `UNKNOWN -> UNKNOWN` reconcile observations append one event each.
- Cause vocabulary (`EffectTransitionCause` in `packages/core/src/effect.ts`):
  `prepare | submit | execute | reconcile | unknown`. `runEffect` labels the
  initial insert `prepare`, `PREPARED -> SUBMITTED` `submit`, execute-path
  outcomes `execute`, reconcile-path outcomes `reconcile`. Journal callers that
  pass no cause are recorded as `unknown` (except `markSubmitted`, whose only
  transition is `submit`). Nothing infers a cause from timing or state.
- Read-only surface: `EffectHistoryReader.listEvents(effectId?)` and
  `listHistory(key?)` returning `{ record, events, coverage }`. `listHistory`
  reads rows and events inside one `BEGIN DEFERRED ... COMMIT` (WAL read
  snapshot, no writer lock, no mutation), so a concurrent commit from another
  connection can never yield an old row with a newer event or a new row
  without its event. Coverage is
  `observed` (chain starts at the row's initial `PREPARED` insert), `partial`
  (row predates evidence but has later events), `unavailable` (no events).
- Migration: `CREATE TABLE IF NOT EXISTS`; repeated open is safe; existing
  `relay_effects` rows and schema are untouched; no backfill of legacy rows.
- Capsule: `relay-capsule/effects.json` is unchanged. `effect-events.json` is
  written only when events exist, hashed in the manifest, counted in
  `counts.effectEvents`. Import validates events against `effects.json`
  (orphans, duplicate seq, broken chains, last event disagreeing with the
  latest-state row, count mismatch are rejected); a capsule without
  `effect-events.json` imports rows with `unavailable` history. Events never
  drive execution decisions.
- CLI: `relay effects --history [--key KEY] [--json] [--storage PATH]`
  (schema `relay.effect-history/1`). `relay effects` output is unchanged.
- `examples/crash-demo.mjs` now also asserts the observed chain is exactly
  `prepare, submit, reconcile-confirm` and that the last event matches the row.

## Verification (Linux, Ubuntu, pnpm 10.33.0)

Commands, run from the repo root with
`PATH=$PWD/packages/adapter-pi/node_modules/.bin:$PATH` (Pi binary for adapter
tests):

```
pnpm install --frozen-lockfile     # Done, lockfile unchanged
pnpm typecheck                     # tsc -b, clean
pnpm test                          # pnpm -r --if-present test
node examples/crash-demo.mjs
```

Results, identical on Node 24.19.0 and Node 22.23.3:

| package        | tests | pass | fail |
|----------------|------:|-----:|-----:|
| epistemic      |   8   |  8   |  0   |
| core           |  40   | 40   |  0   |
| artifact-fs    |  12   | 12   |  0   |
| storage-sqlite |  26   | 26   |  0   |
| cli            |  36   | 36   |  0   |
| mcp            |  49   | 49   |  0   |
| adapter-pi     |   7   |  7   |  0   |
| **total**      | 178   | 178  |  0   |

Targeted regression-first tests added (all included in the counts above):

- `packages/storage-sqlite/test/history.test.ts` (9 tests): full chain,
  rejected transitions append nothing, `unknown` cause for unannotated callers,
  legacy DB (pre-existing `relay_effects` without events) reports
  `unavailable`/`partial` and is not backfilled, repeated open, `replaceAll`
  with and without events, execute vs reconcile attribution, terminal
  re-entry dedup, and (review fix) an interleaved writer on a second
  connection committing between the row and event reads of `listHistory`,
  unfiltered and key-filtered; the pair must be coherent. Verified to fail
  against the pre-fix `listHistory` (2/2 failing) and pass after.
- `packages/storage-sqlite/test/crash-matrix.test.ts` (extended): after every
  crash seam the event chain is checked; latest status equals the last event;
  no `execute` confirmation exists without a provider commit; no recovery
  events are invented on restart.
- `packages/mcp/test/history.test.ts` (3 tests): same-key concurrent submit
  yields exactly one `prepare, submit, execute` chain; repeated uncertain
  reconciles append `UNKNOWN -> UNKNOWN` observations without extra provider
  requests; kill/restart then read-only reconcile yields a `reconcile`
  confirmation and no fabricated events.
- `packages/cli/test/capsule-history.test.ts` (3 tests): export/import round
  trip preserving `seq`; legacy snapshot-only import; rejection of forged
  completion, broken chain, orphan, duplicate seq, count mismatch, and
  tampered latest-state contradiction.

Crash demo (both Node versions):

```
history coverage=observed events=->PREPARED:prepare PREPARED>SUBMITTED:submit SUBMITTED>CONFIRMED:reconcile
PASS  remote counter === 1 (no silent duplicate)
PASS  journal record exists
PASS  journal status === CONFIRMED
PASS  confirmation came via reconciliation
PASS  transition evidence: prepare, submit, reconcile-confirm (no execute-confirm, no invented recovery)
PASS  last committed event agrees with latest-state row
```

Typecheck ordering note: on a fresh clone, `pnpm typecheck` fails with
`packages/adapter-pi/test/deferred.test.ts: Cannot find module '@relay/cli/capsule'`
until `@relay/cli` has been built once. Reproduced on `main` at
`3c18c394a0795301e7bc0758934b8874dea4a333` in a clean worktree with no
changes from this PR, so it is pre-existing and out of scope here.

Native Windows: not run by this session. The above is Linux-only evidence; the
Windows limits recorded in `INDEPENDENT_RELAY_GATE_REVIEW_2026-09-25.md`
(path-separator assertion, POSIX `SIGKILL` in the demo) are unchanged.

## Pi session/tool association (investigated, not implemented)

Public surface inspected in `@earendil-works/pi-coding-agent@0.87.0`
(`dist/core/session-manager.d.ts`, `docs/extensions.md`,
`docs/session-format.md`):

- `ctx.sessionManager.getSessionId(): string` (session UUID) and
  `getSessionFile(): string | undefined` (undefined for in-memory sessions).
- Tool hooks expose `toolCallId` on `tool_call`/`tool_result` events and as the
  first `execute` argument.

These are public and non-secret, but this stage did not demonstrate that they
are stable across the lifecycle Relay needs (session fork/resume/compaction
rewrite `targetSessionFile`; `toolCallId` is per-invocation and the current
Relay adapter does not thread it into `runEffect`). No association column was
added, and no directory/time/string correlation was used. Full M8
Run/Step/Recovery association remains blocked pending a verified stable Pi
identifier reaching the Pi adapter's effect call path.

## Limits

- Evidence exists only for transitions committed after this schema is present;
  legacy rows are labeled `unavailable`, never reconstructed.
- `cause` is caller-asserted (`runEffect` is the only annotating caller);
  unannotated journal users are recorded as `unknown`, not guessed.
- Capsule validation checks internal consistency, not provider truth.
- No hosted CI; no native Windows run; no real provider.

## Files changed

- `packages/core/src/effect.ts`, `packages/core/src/index.ts`,
  `packages/core/src/capsule.ts`
- `packages/storage-sqlite/src/journal.ts`
- `packages/cli/src/capsule.ts`, `packages/cli/src/cli.ts`
- `examples/crash-demo.mjs`, `docs/ARCHITECTURE.md`
- tests: `packages/storage-sqlite/test/history.test.ts` (new),
  `packages/storage-sqlite/test/crash-matrix.test.ts`,
  `packages/mcp/test/history.test.ts` (new),
  `packages/cli/test/capsule-history.test.ts` (new)
- `reports/EFFECT_EVIDENCE_HISTORY_RESULT.md` (this file)

Final remote SHA: recorded in the PR description after push.
