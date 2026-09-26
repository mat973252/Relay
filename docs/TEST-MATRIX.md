# Relay Test Matrix

| ID | Test | Expected invariant |
|---|---|---|
| T01 | Pi extension loads | No Pi fork/patch required |
| T02 | `relay doctor` healthy environment | READY |
| T03 | Optional capability absent | DEGRADED but runnable |
| T04 | Required capability absent | BLOCKED |
| T05 | Effect crash before submit | Safe to execute once |
| T06 | Crash after remote commit before local confirmation | UNKNOWN, not blind retry |
| T07 | Reconcile finds remote result | UNKNOWN -> CONFIRMED |
| T08 | Idempotent provider retry | At most one logical remote effect |
| T09 | Artifact atomic write crash | No valid metadata points at missing content |
| T10 | Artifact lineage | report -> analysis -> source |
| T11 | Pi process restart | Relay metadata/artifacts survive |
| T12 | Capsule interrupted at 25/50/75% | No apparently-valid partial capsule |
| T13 | Capsule hash corruption | Import rejected |
| T14 | Secret isolation | Fixture env secrets are not automatically copied; caller-owned export data requires review |
| T15 | Machine A -> B import | doctor succeeds before activation |
| T16 | Deferred migration | original external job ID reused |
| T17 | Deferred provider 429 | remains pending/backoff |
| T18 | Deferred provider 5xx/timeout | remains pending unless Pi/provider contract says terminal |
| T19 | Invalid credentials | explicit failure/block, not infinite retry |
| T20 | UNKNOWN effect on resume | requires reconcile/policy |
| T21 | repeated resume | no duplicate unsafe effect |
| T22 | artifact after migration | same digest + lineage |
| T23 | workspace remap | no hard-coded `D:\...` dependency inside runtime metadata |
| T24 | Node 22 + Node 24 | CI green |

## Release gate

v0.1 is not releasable until T01–T24 are green or an explicitly documented platform-specific exception is accepted.

## Chaos injection matrix (M6, v0.1 RC)

All injection points are exercised by real tests (in-process `SimulatedProcessDeath` seams or real child-process SIGKILL). "Consistent" means the persisted state is one of the valid states for that boundary — never a mixture.

| # | Injection point | Mechanism | Covered by | Result |
|---|---|---|---|---|
| C01 | before effect journal commit | SIGKILL child | storage-sqlite crash-matrix 1 | no record; safe fresh run; counter 1 |
| C02 | after PREPARED commit | SIGKILL child | crash-matrix 2 | PREPARED; safe continuation; counter 1 |
| C03 | immediately before external request | SIGKILL child | crash-matrix 3 | SUBMITTED; reconcile not-found -> FAILED; counter 0 |
| C04 | after request leaves client | SIGKILL child (provider inflight marker) | crash-matrix 4 | SUBMITTED; reconcile found -> CONFIRMED; counter 1 |
| C05 | after remote commit, before response | SIGKILL child (provider hold window) | crash-matrix 5 | SUBMITTED; reconcile found -> CONFIRMED; counter 1 |
| C06 | after response, before CONFIRMED commit | SIGKILL child | crash-matrix 6 | SUBMITTED; reconcile -> CONFIRMED; counter 1 |
| C07 | after CONFIRMED commit | SIGKILL child | crash-matrix 7 + repeated restarts | dedup on re-entry; counter stays 1 |
| C08 | during artifact temp write | in-process seam | artifact-fs T09 (after-object-tmp, after-meta-tmp) | no visible record; retry succeeds |
| C09 | before artifact atomic rename | in-process seam | artifact-fs T09 (after-object-rename) | object committed, record absent; invariant holds |
| C10 | during capsule creation | in-process seam | cli T12 (25/50/75%) | no capsule file exists |
| C11 | during capsule import (after validation / after staging / after parking old state / after the single `.relay` commit — which carries journal, artifacts, adapter material, and the imported capability contract together / after cleanup) | in-process seam | cli M6 matrix + M7 coherence matrix | old pair intact, or old state parked in `.relay.pre-import-old` with no `.relay` (next import auto-restores it), or the fully imported pair — Relay state and capability contract are never observed in different generations; `relay doctor` resolves the imported contract (`dirname(--storage)/relay.capabilities.yaml`) and never returns READY for a mixed pair |
| C12 | immediately before Pi deferred resume | SIGKILL child | adapter-pi M5/M6 chaos | submissions stay 1; later process resumes |
| C13 | immediately after Pi deferred resume | SIGKILL child | adapter-pi M6 chaos | submissions stay 1; later process resumes cleanly |

Gate invariants re-verified by C01–C13: no silent duplicate unsafe effect; no secret leak (T14 tests sweep doctor/capsule/eval outputs); corrupt/partial capsule rejected (T13); UNKNOWN never auto-converted into a retryable failure (core effect tests: uncertain reconcile keeps UNKNOWN; un-reconciled re-entry throws `EffectNeedsReconciliationError`).
