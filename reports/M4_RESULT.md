# M4 Result — Capsule Export/Import

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- Capsule format (`relay.capsule/1`): gzipped minimal-ustar archive rooted at `relay-capsule/` containing `manifest.json`, `effects.json` (EffectRecord[] with statuses preserved verbatim), `artifacts/index.json` + `artifacts/objects/<ab>/<digest>`, optional `capabilities.yaml` and `adapter/context.json` (opaque adapter material, hashed), and `evidence/export.json` (MigrationEvidence: direction/timestamp/counts).
- Manifest: per-file SHA-256 + size for every non-manifest entry; strict `validateManifest` (portable relative POSIX paths only — T23 enforced at validation, duplicate/missing/hash-format checks).
- Atomic export: archive assembled in a temp dir, fsync, single rename to the final path — an interrupted export leaves NO capsule file (T12 at 25/50/75% via `onEntry` seam).
- Import validation (T13): gunzip → strict ustar parse (header checksums, truncation detection) → manifest declared-file set equality (missing AND undeclared files both fatal) → per-file size + SHA-256 re-hash → artifact object re-hash against its digest.
- Import staging + activation boundary: everything staged in temp, committed by rename/copy into `<target>/.relay/`; refuses to clobber a workspace holding effect records unless `--overwrite`; explicitly prints that activation is pending and requires `relay doctor` first. Journal import via new `SqliteEffectJournal.replaceAll()` (single transaction; statuses/UNKNOWN preserved, never auto-converted).
- CLI: `relay export [--output] [--workspace] [--capabilities] [--adapter-context]`, `relay import <capsule> [--workspace] [--overwrite]` (rejections exit 2), plus `relay effects [--json]` for inspection (schema `relay.effects/1`).
- Secret exclusion by construction: export packs an allow-list only (`.env` files, workspace files, env values never enter the archive; capsule code never reads the environment).

## API decisions

- No `tar` dependency: minimal deterministic ustar writer/reader in `@relay/cli` (`tar.ts`, regular files only, fixed mtime/mode for reproducible bytes; gzip via `node:zlib`). Entry names ≤99 chars, no traversal, POSIX separators only.
- Evidence does not hash the manifest (circular); per-file hashes in the manifest + fixed manifest path + strict tar checks cover archive integrity.
- Core stays pure: only the manifest/evidence contracts live in `@relay/core` (`capsule.ts`); FS/tar mechanics are operator-tool concerns in `@relay/cli`.
- Migration is single-writer and operator-gated (v0.1 scope): import never activates, never resumes effects by itself.

## Tests run (real commands, real results)

`corepack pnpm check` — totals **88 pass, 0 fail** (core 39, storage-sqlite 15, artifact-fs 11, cli 18, adapter-pi 5). New: `cli/capsule.test.ts` (4 suites):

1. **A→B migration**: seeded A (3-artifact chain, CONFIRMED + SUBMITTED effects, capabilities.yaml, adapter context, decoy `.env` with secret) → export → import into fresh B: effect statuses preserved exactly; same artifact digests as A (T22); full lineage reconstructable in B; content readback; `.env` not packed; capsule bytes contain no secret (T14); all paths relative POSIX (T23); adapter context present; re-import without `--overwrite` refused.
2. **T12**: export interrupted at 25/50/75% → no capsule file exists at any fraction.
3. **T13**: byte-flip, truncation, and non-archive input all rejected; no `.relay/` created in the target on rejection.
4. **Live migration with real remote effect**: A's child SIGKILLed after remote commit (journal SUBMITTED, provider counter=1) → capsule → import B → B's child re-enters, reconciles, confirms — counter stays exactly 1. Plus T15: `relay doctor` in B with the imported capability contract → `activation: BLOCKED` (exit 2) until the referenced secret exists — activation stays doctor-gated.

## Files changed

- `packages/core/src/capsule.ts` (new, exported).
- `packages/cli/src/tar.ts`, `packages/cli/src/capsule.ts` (new); `packages/cli/src/cli.ts` (export/import/effects commands).
- `packages/storage-sqlite/src/journal.ts` (`replaceAll`).
- Tests: `packages/cli/test/capsule.test.ts`.

## Gate check

- "Export from machine-A fixture, import into machine-B fixture" — **PASS** (both fixture workspaces and a live-effect migration).
- "Same Pi work context/history can be inspected and resumed" — **PASS** at the Relay layer: effects/artifacts/lineage inspectable via `relay effects|artifacts|lineage` after import, and a migrated SUBMITTED effect resumes by reconciliation without duplicate remote work. Real Pi deferred/suspended state migration is M5 scope.

## Next milestone blockers

None. M5 (Deferred migration via current Pi suspended/deferred APIs — provider submission count == 1 across restart+migration) can start; it requires inspecting the installed Pi's public deferred/suspended APIs first (`tasks/` continues in M5 task file).
