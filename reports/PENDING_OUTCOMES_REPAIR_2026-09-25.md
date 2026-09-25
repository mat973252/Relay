# Pending-outcome MCP repair — 2026-09-25

Task: `tasks/NEXT_ITERATION_PENDING_OUTCOMES.md`. Branch `devin/safety-pending-outcomes`,
base commit `d6859bbdd09cf03ddfeab4fd8c41e0044e8c46d6` (main). Scope: the two
independently reproduced provider-outcome bugs only. No Step 6/7, no AgentLens
adapters, no package publish, no real provider calls — all tests use `127.0.0.1`
fake providers and `mkdtemp` disposable workspaces.

## Root causes and fix

1. `reconcileAction` mapped every 2xx reconcile body whose status was not
   `complete` to `{ found: false }`, which `runEffect` settles as terminal
   FAILED. A `200 {"status":"pending"}` (accepted, still processing) therefore
   falsely proved non-execution.
   Fix: `reconcileAction` now distinguishes three contract outcomes.
   `found-flag` keeps `found===true -> executed`, `found===false -> proven
   non-execution`, anything else -> uncertain. `status-field` resolves
   `status ∈ completeStatuses` (default `["complete"]`) to executed and
   `status ∈ notExecutedStatuses` (new optional config, default none) to proven
   non-execution; every other value — `pending`, unknown strings, missing or
   non-string fields, unparseable bodies — resolves uncertain and leaves the
   journal UNKNOWN.
2. `executeAction` treated any 2xx body as proof of execution, so a submit
   `202 {"status":"pending"}` became CONFIRMED with no remote commit.
   Fix: HTTP 202 (accepted) always resolves `AmbiguousEffectError` -> UNKNOWN.
   For `status-field` actions the submit body must report a contract-proven
   completion status (`completeStatuses`) or it resolves UNKNOWN; `found-flag`
   actions keep their existing 2xx-means-executed behavior unchanged.

`ReconcileOutcome.found:false` is now documented as contract-backed proof of
non-execution; `runEffect` semantics are unchanged (proven non-execution -> FAILED,
uncertain -> UNKNOWN stays, CONFIRMED/FAILED stay terminal, no resubmission).

Config additions (`mcp-actions.json`, `status-field` only, validated:
non-empty string lists): `reconcile.completeStatuses`, `reconcile.notExecutedStatuses`.

Independent-review hardening (second commit): `"pending"` (any case) is
rejected in both lists — a pending status is never a terminal proof — and
overlapping `completeStatuses`/`notExecutedStatuses` is rejected, since a
status cannot prove both execution and non-execution. The lists are also
bound into `actionFingerprint`: an explicitly configured status contract
changes the remote interpretation, so `runEffect` refuses to reuse an
operation recorded under a different one (rejected before any remote call).
When both options are absent, `stableStringify` drops them and the hash is
byte-identical to the pre-repair one, so existing default configs keep
reusing their operation ids.

## Tests

New `packages/mcp/test/pending-outcomes.test.ts` (13 tests, expanded to 13
for the review findings) with a `pending-provider` fixture
(accept-then-commit). At the base commit 7 of the original 11 fail — both
reproduced bugs plus the unverifiable-status cases — and all 13 pass after
the fix:

- submit `202 {"status":"pending"}` and `200 {"status":"pending"}` with no
  remote commit -> outcome `unknown`, journal UNKNOWN (was CONFIRMED);
- ambiguous submit (409) -> UNKNOWN; read-only reconcile `200
  {"status":"pending"}` -> stays UNKNOWN (was FAILED);
- reconcile status `pending`/`exploded`/missing/`42` and non-JSON bodies ->
  UNKNOWN;
- configured `notExecutedStatuses:["failed"]` + provider reports `failed` ->
  FAILED, zero additional POSTs (reconcile never resubmits);
- accept-then-commit provider: submit stays UNKNOWN, later reconcile proves
  execution -> CONFIRMED with exactly one POST and one remote commit;
- config rejects `completeStatuses:["pending"]`, `["PENDING"]`,
  `notExecutedStatuses:["pending"]`, and overlapping lists — exit 78;
- status lists bound into request identity: after a default-contract
  UNKNOWN is recorded, a config with different status lists rejects reuse
  (`different effect`) BEFORE any remote reconcile call; restoring the
  default contract makes the operation reconcilable again;
- preserved: found-flag synchronous 200 -> CONFIRMED; `status:"complete"`
  submit -> CONFIRMED; configured `rejectStatuses` -> FAILED.

## Commands run and results

Environment: Ubuntu (x86_64), pnpm 10.33.0 via corepack, `pi` 0.87.0 provided
by `packages/adapter-pi/node_modules/.bin` on PATH. Fake providers only, all
`127.0.0.1`; workspaces under `mkdtempSync`, removed after each test.

| Command | Node | Result |
|---|---|---|
| `pnpm typecheck` (`tsc -b`) | v24.19.0 | pass |
| `PATH=…/adapter-pi/node_modules/.bin:$PATH pnpm test` | v24.19.0 | 157 pass / 0 fail (core 40, epistemic 8, artifact-fs 12, storage-sqlite 17, cli 33, mcp 40 incl. 13 new, adapter-pi 7) |
| `node examples/crash-demo.mjs` | v24.19.0 | PASS x4, remote counter = 1 |
| `pnpm typecheck` | v22.23.3 | pass |
| `pnpm test` (same PATH) | v22.23.3 | 157 pass / 0 fail |
| `node examples/crash-demo.mjs` | v22.23.3 | PASS x4, remote counter = 1 |

Two-process lock regressions are inside the mcp suite (`lock.test.ts`:
workspace ownership + cross-process takeover race, 10 tests) — all pass on
both Node versions.

## Remaining limits

- Preexisting at base (verified identical at `d6859bb`): on a fully clean
  tree `tsc -b` compiles `adapter-pi` before `cli`, so
  `adapter-pi/test/deferred.test.ts` cannot resolve `@relay/cli/capsule`
  (TS2307) until `cli` has been built once. Workaround used for Node 22:
  `tsc -b packages/cli` first. Not caused by and not fixed in this repair.
- `cli` doctor tests require `pi` on PATH; provided via the adapter-pi
  devDependency bin dir. Absent `pi`, doctor correctly reports fail (seen in
  the first run before PATH was set) — environmental, unrelated to this fix.
- For `status-field` providers whose protocol cannot distinguish
  accepted/pending/executed/rejected, only explicitly configured
  `notExecutedStatuses` may settle FAILED; otherwise operations remain
  UNKNOWN pending reconciliation — no terminal state is invented.
- The safety gate is NOT claimed cleared: this stage stops here for
  independent review.

## Files changed

- `packages/mcp/src/actions.ts` — status-field contract docs,
  `completeStatuses`/`notExecutedStatuses` config + validation.
- `packages/mcp/src/server.ts` — submit: 202/unproven 2xx bodies -> UNKNOWN;
  reconcile: three-way executed/proven-not-executed/uncertain mapping.
- `packages/core/src/effect.ts` — `ReconcileOutcome` + re-entry doc comments
  only (semantics unchanged).
- `packages/mcp/test/fixtures/pending-provider.ts` — new fake provider.
- `packages/mcp/test/pending-outcomes.test.ts` — new regression suite.
- `reports/PENDING_OUTCOMES_REPAIR_2026-09-25.md` — this report.
