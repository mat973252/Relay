# M2 Result — Artifact Registry

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- `ArtifactStore` (`@relay/artifact-fs`): filesystem content-addressed store.
  - Identity: `artifact://sha256/<digest>`; objects at `objects/<ab>/<digest>`; metadata records as atomically-written JSON sidecars under `records/<record-id>.json`; temp staging under `tmp/`.
  - Records carry: producer (`type`/`id`), media type, byte size, parent record ids (lineage edges), optional opaque execution refs (`session`/`run`/`toolCall`), createdAt.
  - Same content → same digest (single object, multiple records); `resolve()` accepts record id, bare digest, or `artifact://` URI.
- Atomic write ordering enforces T09: object is fsynced+renamed into place strictly before the record sidecar is renamed; a parseable record therefore always references existing content. Crash leftovers live only in `tmp/` and are inert (`gcTemp()`).
- `lineage(ref)` walks the parent graph with cycle/missing-parent detection; problems are reported, never silently dropped.
- `verify()` re-hashes every referenced object and checks sizes + parent existence (digest/lineage integrity evidence for later milestones).
- CLI: `relay artifacts [--json]` (schema `relay.artifacts/1`) and `relay lineage <ref> [--json]` (schema `relay.lineage/1`); unknown ref exits 66, usage errors 64.

## API decisions

- Records are not content-addressed (only objects are): two artifact instances with identical bytes but different lineage remain distinct records — required for lineage like `source -> analysis -> report` where reuse is common.
- Execution refs are opaque strings, no Pi types imported; `adapter-pi` will populate them in later milestones.
- `verify()`/`lineage()` return problems instead of throwing: partial evidence is data, and callers (doctor, capsule validation) decide severity.

## Tests run (real commands, real results)

`corepack pnpm check` — totals **68 pass, 0 fail** (core 31, storage-sqlite 15, artifact-fs 11, cli 6, adapter-pi 5).

- artifact-fs/store.test.ts:
  - CAS semantics (dedup by digest, distinct digests, content readback).
  - T09 crash matrix at `after-object-tmp` / `after-object-rename` / `after-meta-tmp`: after each crash + reopen, `list()` shows nothing half-written and `verify()` is clean; retry succeeds.
  - T10: `report -> analysis -> source` lineage reconstructable after store reopen; missing parent reported as problem; tampered object detected by `verify()` (digest mismatch).
  - T11: artifacts written by a real child process are listable with full lineage and content readback in the parent process.
- cli.test.ts: `artifacts` text + JSON schema; `lineage` text ordering (root before parents) + JSON tree; exit 66 unknown ref; exit 64 usage.
- Manual operator run: `relay artifacts` + `relay lineage artifact://sha256/...` render the three-level chain.

## Files changed

- `packages/artifact-fs/src/store.ts` (new), exported via `packages/artifact-fs/src/index.ts`.
- `packages/cli/src/cli.ts` (artifacts/lineage commands).
- Tests: `packages/artifact-fs/test/store.test.ts`, fixture `packages/artifact-fs/test/fixtures/artifact-chain-child.ts`, `packages/cli/test/cli.test.ts` extended.

## Gate check

- "`source -> analysis -> report` lineage is reconstructable after Pi process restart" — **PASS** (store-reopen unit + real child-process T11 test; artifacts live outside any chat/context process).

## Next milestone blockers

None. M3 (Capability Contract + Doctor: `relay.capabilities.yaml`, required/optional model, secret references, READY/DEGRADED/BLOCKED) can start per `docs/ROADMAP.md`.
