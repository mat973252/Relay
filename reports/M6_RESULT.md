# M6 Result — Chaos Gate / v0.1 RC

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- **Atomic capsule import (C11):** `importCapsule` commit redesigned as an all-or-nothing workspace swap — validation → complete staging in temp → park old `.relay` as `.relay.pre-import-old` → rename staged dir into place → cleanup. Crash seam points: `after-validation`, `after-stage`, `after-old-swap`, `after-commit`. A crash can now leave only: old state intact / old state parked (recoverable by rename) / fully imported state — never a half journal + half artifacts mixture. The pre-import emptiness check no longer creates the target database as a side effect.
- **Pi resume chaos seams (C12/C13):** `deferred-child` fixture supports death immediately before `fetchDeferred` and immediately after the first successful resume (real SIGKILL via env switch).
- **Chaos matrix documented:** `docs/TEST-MATRIX.md` now carries the consolidated C01–C13 injection-point table mapped to the tests that exercise each point, with the invariant each proves.

## Crash matrix coverage (consolidated)

| Boundary group | Points | Where proven |
|---|---|---|
| Effect journal / external request | C01–C07 (7 boundaries, real SIGKILL children) | `storage-sqlite/test/crash-matrix.test.ts` (M1) |
| Artifact atomic write | C08–C09 | `artifact-fs/test/store.test.ts` T09 (M2) |
| Capsule creation | C10 at 25/50/75% | `cli/test/capsule.test.ts` T12 (M4) |
| Capsule import | C11 ×4 | `cli/test/capsule.test.ts` M6 matrix (new) |
| Pi deferred resume | C12–C13 | `adapter-pi/test/deferred.test.ts` chaos test (new) |

## Tests run (real commands, real results)

`corepack pnpm check` — totals **94 pass, 0 fail** (core 39, storage-sqlite 15, artifact-fs 11, cli 22, adapter-pi 7).

New in this milestone:

- `cli` M6 import crash matrix (4 points): pre-existing target state (old journal + old artifact) survives `after-validation`/`after-stage` untouched; `after-old-swap` parks the old state recoverably with no `.relay` present; `after-commit` leaves the fully imported registry (3 records, `verify()` clean, no parked dir).
- `adapter-pi` chaos test: submit → migrate → SIGKILL before resume → SIGKILL after first successful resume → final clean resume; **submission count stays exactly 1 across all three resume processes**.

Gate invariants re-verified repo-wide:

- **No silent duplicate unsafe effects** — C01–C07, C12–C13 all assert counter/submission ≤ 1 and correct status transitions.
- **No secret leak** — T14 tests sweep doctor output, capability evaluations, and capsule bytes for a planted secret; export is allow-list based and capsule code never reads the environment.
- **Corrupt/partial capsule rejected** — T13 (byte-flip, truncation, non-archive) plus T12 (no partial capsule file ever exists).
- **UNKNOWN never auto-converted into a retryable failure** — core effect tests: uncertain reconcile keeps UNKNOWN; re-entry without reconcile throws `EffectNeedsReconciliationError`; `SUBMITTED + not-found` becomes FAILED-with-evidence, never an automatic retry.

## Files changed

- `packages/cli/src/capsule.ts` (atomic swap + crash seam), `packages/cli/test/capsule.test.ts` (M6 matrix).
- `packages/adapter-pi/test/fixtures/deferred-child.ts` (resume crash seams), `packages/adapter-pi/test/deferred.test.ts` (chaos test).
- `docs/TEST-MATRIX.md` (C01–C13 chaos matrix section).

## v0.1 release-candidate status

All six milestones (M0–M6) gates green on the audited environment (Node 22.18, WSL, Pi 0.87.0). Remaining before tagging v0.1 (documented, not blockers for RC):

- T24: run the full matrix on Node 24 (only Node 22 available in this environment).
- Real-provider deferred migration (M5 used the contract-faithful local mock; a real batch provider E2E needs external credentials and is operator-scope).
- The `.relay.pre-import-old` recovery is manual (rename back); an operator helper can be added if real usage wants it.
