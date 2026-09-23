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
| T14 | Secret isolation | Secret plaintext absent from capsule/state/log/artifacts |
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
