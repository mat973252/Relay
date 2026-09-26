# Result: `relay status` — read-only mat-console.status/1 producer

Date: 2026-09-26. Stage: local read-only producer of `mat-console.status/1`
for the mat-console integration (stage 2; stage 1 was the console-side
integration, already accepted).

## Implemented behavior

- `SqliteEffectJournalReader` (`packages/storage-sqlite/src/journal.ts`,
  exported from `index.ts`): opens an existing journal with `node:sqlite`
  `readOnly: true` (SQLITE_OPEN_READONLY). No directory/file creation, no
  `journal_mode`/`synchronous`/`foreign_keys` pragma writes, no
  CREATE/ALTER/DROP, no VACUUM. Missing path, non-file, non-SQLite,
  non-Relay schema (no `relay_effects` or missing required columns) all
  reject without touching the input. Both tables are read inside one
  `BEGIN DEFERRED` snapshot — the same consistency boundary as
  `SqliteEffectJournal.listHistory`, whose coverage classification
  (`observed`/`partial`/`unavailable`) is reused unchanged.
- Legacy schema support: optional columns absent from `relay_effects`
  (e.g. `intent_json`) read as NULL; a missing `relay_effect_events` table
  yields `unavailable` history for every row; a legacy events table with
  extra free-form columns (`reason`, `remote_ref`) is read with the columns
  never selected and never migrated.
- `relay status [--storage PATH] [--output PATH]` in `@relay/cli` +
  `buildStatusDocument` (`packages/cli/src/status.ts`): emits
  `mat-console.status/1` with aggregate evidence only — per-status counts,
  observed-history coverage counts, and the journal's own latest write time
  in `health.summary` (distinct from `generated_at`, the export time).
  `ttl_seconds: 300`. Attention items: `unresolved-unknown-effects` (warn),
  `history-coverage-gap` (info), `journal-unavailable` (warn).
- Health is never `ok`: `attention` only when the journal itself shows
  unresolved UNKNOWN effects or history gaps, otherwise `unknown`, with the
  summary stating it is a local journal sample, not production readiness.
  `progress`, `milestones`, and `runs` are omitted — the journal cannot
  honestly support them.
- The document carries no effect keys, ids, kind, `reason`, `remoteRef`,
  `result_json`, `intent_json`, artifacts, credentials, or Pi session/tool
  ids. Unavailable input still yields a valid document (exit 1).
- `docs/STATUS-EXPORT.md` documents input, output, refresh, limits, and the
  local HTTP + CORS requirement for the console's `?url=` adapter.
  `relay-status.json` is gitignored. Evidence artifact:
  `reports/mat-console-status-2026-09-26/status.sample.json` (labeled test
  data, generated from a synthetic journal).

## API decisions

- Reader lives in `journal.ts` to reuse `toRecord`/`toEvent` and the exact
  coverage classification rather than duplicating semantics.
- Unavailable-journal reasons are mapped to generic wording before entering
  the document — filesystem paths and SQLite error text go to stderr only
  (the document is meant to be publishable).
- Exit codes: `0` sampled · `1` journal unavailable (document still emitted)
  · `2` output write failed · `64` usage.

## Tests run

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm -r exec tsc -b      # project-reference build order, then:
corepack pnpm typecheck           # tsc -b — clean
corepack pnpm -r --if-present test
```

- Node v24.19.0 (Ubuntu, this machine): storage-sqlite 34/34 pass (7 new
  read-only tests), core 40/40, artifact-fs 12/12, epistemic 8/8, cli 35/44.
- Node v22.23.3 (same machine, nvm): identical results — storage-sqlite
  34/34, cli 35/44.
- The 9 cli failures are all `pi CLI not available on PATH` (doctor probe and
  cascades) — a pre-existing environment limit; identical on unmodified main
  (verified via stash). `pi` is not installed on this machine.
- New tests assert: missing input creates no file/dir; populated, legacy
  (no events table), and pre-migration (extra free-form event columns) DB
  files are byte-identical (SHA-256) after export; legacy events are never
  migrated; corrupt/non-journal input rejected without mutation; coherent
  row/event snapshot under an interleaved writer; marker strings in keys,
  ids, `reason`, `remoteRef`, `result_json`, `intent_json` and an env secret
  never appear in output; contract shape (contract id, `generated_at` ISO-Z,
  health enum, no secret-looking keys); usage error → 64.

## Consumer validation

`mat-console` cloned outside this repo. `src/contract/status.ts` compiled
standalone (tsconfig `--ignoreConfig`; the repo's TS 7 cli required it) and
`validateProjectStatus` run against two real exports:

- populated journal export → `{ ok: true }`
- missing-journal (unavailable) export → `{ ok: true }`

## Known side effect

Opening a WAL-mode database read-only materializes `<db>-shm`/`<db>-wal`
scratch files next to the journal (SQLite's shared-memory index; any WAL
read does this, including `sqlite3` CLI). The journal file's bytes are never
modified — asserted byte-identical in tests. They are not created when the
input does not exist at all.

## Limitations / boundaries

- The export is a local journal sample: aggregate counts and coverage labels
  only. It does not prove production readiness, provider-side truth, or Pi
  session/run state. The journal has no Pi session association (see
  `reports/INDEPENDENT_PI_RELAY_LINK_ACCEPTANCE_2026-09-26.md` — the keyprobe
  showed an exact key match in an isolated fake-provider run, not exclusive
  ownership or general causality), so none is claimed.
- No Relay web UI/server was added; nothing calls effects, providers, or
  models; nothing was published or merged.
- Windows and real-provider environments were not exercised; all evidence is
  Linux + fake/synthetic journals. The overall Relay safety gate remains
  CLOSED.

## Files changed

- `packages/storage-sqlite/src/journal.ts` — `SqliteEffectJournalReader`
- `packages/storage-sqlite/src/index.ts` — export
- `packages/storage-sqlite/test/readonly.test.ts` — 7 new tests
- `packages/cli/src/status.ts` — `buildStatusDocument` (new)
- `packages/cli/src/cli.ts` — `relay status` command + usage
- `packages/cli/test/status.test.ts` — 7 new tests
- `docs/STATUS-EXPORT.md`, `README.md`, `.gitignore`
- `reports/mat-console-status-2026-09-26/` — labeled fixture artifact
- `reports/MAT_CONSOLE_STATUS_RESULT.md` — this report
