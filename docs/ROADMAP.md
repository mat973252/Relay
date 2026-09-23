# Relay v0.1 Roadmap

## M0 — Pi-native bootstrap

Goal: Relay loads beside Pi without a Pi fork.

Deliverables:
- pnpm monorepo
- core package
- Pi adapter package
- CLI package
- `relay doctor`
- current Pi version/API compatibility probe
- minimal extension command visible from Pi

Gate:
- install/load on existing Pi
- no patch to Pi source
- typecheck/tests green

## M1 — External Effect Guard

Goal: unsafe outside-world mutations never silently duplicate after crash.

Deliverables:
- `EffectRecord`
- statuses: PREPARED/SUBMITTED/CONFIRMED/FAILED/UNKNOWN
- idempotency key + request hash
- `effect()` wrapper
- reconciliation interface
- mock HTTP counter provider
- crash injection around request/commit/confirmation boundaries

Gate:
- a single logical unsafe operation never increments mock remote counter twice silently
- uncertain state remains UNKNOWN until reconciled

## M2 — Artifact Registry

Goal: important outputs exist outside chat context and carry lineage.

Deliverables:
- FS content-addressed store
- atomic write
- SHA-256
- metadata/index
- parent references
- `relay artifacts`
- `relay lineage`

Gate:
- `source -> analysis -> report` lineage is reconstructable after Pi process restart

## M3 — Capability Contract + Doctor

Goal: detect environment drift before resume.

Deliverables:
- `relay.capabilities.yaml`
- required/optional capability model
- secret references, never values
- doctor checks
- READY/DEGRADED/BLOCKED summary

Gate:
- required missing capability blocks activation
- optional missing capability degrades only
- secret value grep over project/capsule returns zero matches

## M4 — Capsule Export/Import

Goal: controlled migration between environments.

Deliverables:
- manifest
- atomic export
- file hashes
- secret exclusion
- import validation
- migration evidence
- activation boundary

Gate:
- export from machine-A fixture
- import into machine-B fixture
- same Pi work context/history can be inspected and resumed

## M5 — Deferred migration

Goal: reuse Pi's durable/suspended/deferred state across migration.

Deliverables:
- adapter support for current Pi suspended/deferred state
- no custom replacement DeferredHandle
- migration test with mock async provider

Gate:
- provider submission count == 1
- process restart count >= 1
- migration count >= 1
- remote job completes after target-side Pi resume

## M6 — Chaos / v0.1 RC

Inject crashes at:
- before effect journal commit
- after journal commit
- before external request
- after remote commit/before local confirmation
- after confirmation
- during artifact temp write
- before artifact atomic rename
- during capsule creation
- during capsule import
- immediately before Pi resume
- immediately after Pi resume

Gate:
- crash matrix documented
- no secret leak
- no silent duplicate unsafe effects
- corrupt/partial capsule rejected
- UNKNOWN never auto-converted into a retryable failure
