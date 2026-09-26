# `relay status` — mat-console status export

`relay status` emits one [`mat-console.status/1`](https://github.com/mat973252/mat-console/blob/main/docs/protocol-v1.md)
document describing what the local Relay **effect journal** currently shows.
It is a read-only producer for the [mat-console](https://github.com/mat973252/mat-console)
single-project read-only view.

```bash
# build once from the repository root
corepack pnpm install && corepack pnpm -r exec tsc -b

# emit to stdout
node packages/cli/dist/src/cli.js status [--storage <journal.db>]

# or write a file (gitignored name)
node packages/cli/dist/src/cli.js status --output relay-status.json
```

`--storage` defaults to `./.relay/storage.db`, same as `relay effects`.

## Input

An existing `relay_effects`/`relay_effect_events` SQLite journal. The open is
`SQLITE_OPEN_READONLY` via `node:sqlite` `readOnly: true`:

- no directory or file creation, no WAL/pragma writes, no schema creation or
  migration, no `VACUUM` — a journal the exporter did not create is never
  modified (the file's bytes are byte-identical before and after);
- legacy schemas are read as-is: missing optional columns read as NULL, a
  missing `relay_effect_events` table yields `unavailable` history — nothing
  is backfilled or inferred;
- rows and events are read inside one deferred transaction, so the export is
  a single consistent committed snapshot;
- provider-controlled free-form columns (`intent_json`, `remote_ref`,
  `result_json`, `reason`) are never selected — they cannot reach the
  document;
- rows/events with unreadable controlled fields (unrecognized status,
  non-integer or out-of-Date-range time, malformed shape) are dropped and
  reported as a
  `malformed-journal-rows` attention item — never sampled as healthy, and a
  record whose event chain contains a malformed event falls back to
  `unavailable` coverage;
- missing, non-Relay, or corrupt input produces a valid document with
  `health.state: "unknown"` and a `journal-unavailable` attention item
  (exit code 1) — never a fabricated sample. Raw error text goes to stderr
  only, never into the document.

Opening a WAL-mode journal read-only may materialize `<db>-shm`/`<db>-wal`
scratch files next to it — SQLite's shared-memory index, standard for any WAL
read (including the `sqlite3` CLI). The journal file itself is never written.

## Output content

Aggregate evidence only:

- `health.summary` — effect count per status, how many have fully observed
  transition history, and the journal's own latest write time (distinct from
  `generated_at`, which is the export time);
- `attention[]` — `safety-gate-closed` (always present; links the gate review),
  `malformed-journal-rows`, `unresolved-unknown-effects` (effects halted in
  UNKNOWN pending reconcile), `history-coverage-gap` (rows with
  `partial`/`unavailable` history), `journal-unavailable`;
- `health.state` is never `ok`: a clean journal sample is not evidence of
  production readiness. It is `attention` when the journal itself shows
  unresolved UNKNOWN effects, history gaps, or malformed rows, else `unknown`;
- `progress`, `milestones`, and `runs` are omitted — the journal cannot
  honestly support them.

The document never carries effect keys, ids, `kind`, `reason`, `remoteRef`,
`result_json`, `intent_json`, artifact references, credentials, or Pi
session/tool ids. `ttl_seconds` is 300 — a point-in-time export, refresh by
re-running the command.

`--output` must never be the journal or one of its SQLite sidecars
(`-wal`/`-shm`/`-journal`): the command refuses by canonical path and inode
identity (relative-path, symlink, and hardlink aliases included) before any
write — exit code 2.

## Refresh

Re-run the command on a schedule or before opening the console, e.g.:

```bash
watch -n 60 'node packages/cli/dist/src/cli.js status --output relay-status.json'
```

## Serving to the console

mat-console reads the document through its HTTP adapter (`?url=`). The file
must be reachable over unauthenticated HTTP with CORS enabled, e.g.:

```bash
npx serve -l 8080 --cors .    # or any static server with Access-Control-Allow-Origin
```

then open the console with `?url=http://localhost:8080/relay-status.json`.
Without `Access-Control-Allow-Origin` the browser console cannot read the
file and shows a fetch error, never a healthy state.

## Limits

- Local journal sample only — it says nothing about production readiness,
  provider-side truth, or Pi session/run state.
- The journal carries no Pi session association (see
  `reports/INDEPENDENT_PI_RELAY_LINK_ACCEPTANCE_2026-09-26.md`), so no
  session linkage is claimed in the export.
- Exit codes: `0` journal sampled · `1` journal unavailable (document still
  emitted) · `2` output write failed or refused (journal/sidecar collision)
  · `64` usage error.
