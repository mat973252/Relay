# Import Consistency Result — Step 1 (Import Coherence)

Status: **PASS** — Step 1 complete, stopped for review per `tasks/NEXT_ITERATION_IMPORT_CONSISTENCY.md`.

## Chosen commit model

- **Single commit boundary:** `relay import` stages a complete replacement `.relay` **on the target filesystem** and crosses exactly one rename: old `.relay` → `.relay.pre-import-old`, staged dir → `.relay`. The imported capability contract travels **inside** the swap as `.relay/relay.capabilities.yaml`. There is no separate capability commit, so the "new Relay state + old/missing contract" window no longer exists structurally.
- **Root-level `relay.capabilities.yaml` is defined as the authoring copy for source workspaces**, not part of imported state: `relay import` never reads or writes it. It keeps governing only when no imported contract exists.
- **Doctor resolution order (doctor and import resolve the same contract):**
  1. explicit `--capabilities PATH` (operator responsibility);
  2. imported contract at `dirname(--storage)/relay.capabilities.yaml`;
  3. workspace-root authoring copy (`dirname(dirname(--storage))/relay.capabilities.yaml`).
  Resolution derives from `--storage` (default `./.relay/storage.db`), so doctor evaluates the contract paired with the exact Relay state it is gating.
- **Recovery (pre-staging, on every import attempt):** stale `.relay-import-*` staging dirs are removed; if `.relay` is missing but `.relay.pre-import-old` exists (death between parking and installation), the parked old pair is restored before the import proceeds. A parked state with no `.relay` therefore has a documented, tested recovery path, and an empty-state doctor probe during that window cannot pair a *new* state with the *wrong* contract (the invariant forbids new-state/wrong-contract, not empty-state/old-contract).
- **Export round-trip:** `exportCapsule` auto-detects the contract — explicit `capabilitiesPath` wins, else `.relay/relay.capabilities.yaml`, else the root copy — so machine B → C carries the contract B actually governs by.
- Capsule format unchanged: existing valid capsules import identically (`capabilities.yaml` entry now lands inside `.relay` instead of the workspace root). Artifact hashes, effect statuses (UNKNOWN preserved), and adapter material handling untouched. Secrets remain name-references only; capsule code never reads the environment.

## Exact crash points (import sequence)

| Point | State after death | Governing pair | Recovery |
|---|---|---|---|
| after-validation | nothing touched | old-old | retry import |
| after-stage | staged dir only (cleaned next run) | old-old | retry import |
| after-old-swap | old parked, no `.relay` | parked old-old (restored on next import; manual `mv .relay.pre-import-old .relay` also works) | next import restores, then proceeds |
| after-relay-commit | new `.relay` incl. contract; parked remains | **new-new** | next import (clears parked) |
| after-commit | new-new, parked cleaned | new-new | none needed |

Filesystem-error behavior: staging/parking failures (e.g. unwritable workspace) abort before any target mutation — old pair intact (tested via `chmod 0555`).

## Tests (written first; fail-on-pre-fix verified)

New suite `M7 import/capability coherence` in `packages/cli/test/capsule.test.ts` (8 tests): target seeded with old effects + artifact + **old root contract** (required env var that IS set ⇒ doctor READY when it governs); capsule carries new effects + **new contract** (required env var never set ⇒ doctor BLOCKED when it governs). `relay doctor` exit code discriminates which contract governs, so every assertion is a real coherence check:

1. successful import ⇒ new-new pair, contract inside `.relay`, parked cleaned;
2. capsule **without** contract ⇒ state imports, old root contract keeps governing (exit 0);
3–6. death at `after-validation` / `after-stage` ⇒ old-old; death at `after-relay-commit` / `after-commit` ⇒ new-new — **never mixed**; each followed by a recovery import completing to new-new;
7. death `after-old-swap` ⇒ parked state; next import auto-restores and completes coherently;
8. unwritable workspace ⇒ import rejected, old pair intact.

Pre-fix evidence: with only a new `after-relay-commit` seam added to the old code, 6 of 8 failed (`imported contract must live inside .relay`; mixed pair returned doctor exit 0). After the fix: 8/8 pass. Existing M4 A→B, M6 crash matrix, and M3 capability suites unchanged in intent (T15 doctor now resolves the imported contract without `--capabilities`).

## Commands and results

- Environment: Node **v22.18.0** (WSL), Pi CLI **0.87.0**. Node 24 leg NOT run this round.
- Baseline before editing: `corepack pnpm check` — 107 pass / 0 fail (epistemic 8, core 40, artifact-fs 12, storage-sqlite 17, cli 23, adapter-pi 7).
- After fix: `corepack pnpm check` — **115 pass / 0 fail** (epistemic 8, core 40, artifact-fs 12, storage-sqlite 17, cli 31, adapter-pi 7).
- `git diff --check` — clean.
- `git status` untracked: `tasks/NEXT_ITERATION_IMPORT_CONSISTENCY.md` (this task file).

## Files changed (this step)

- `packages/cli/src/capsule.ts` — contract staged inside `.relay`, single-commit sequence, pre-staging recovery, `after-relay-commit` seam, export auto-detect, `ImportResult.importedContract`.
- `packages/cli/src/cli.ts` — doctor contract resolution order (derived from `--storage`), import output + usage text.
- `packages/cli/test/capsule.test.ts` — M7 suite; T15 assertion updated to imported-contract resolution.
- `docs/TEST-MATRIX.md` — C11 wording corrected (guarantee now explicitly covers the contract).
- `.gitignore` — runtime staging/parked paths.

## Pre-existing uncommitted review fixes carried through (2026-09-23 baseline, not authored in this step)

`packages/core/src/effect.ts` + test (semantic-key identity guard), `packages/artifact-fs/src/store.ts` + test (verify checks artifactId identity), `packages/storage-sqlite/src/journal.ts` + test (state-transition constraints), `src/epistemic-store.ts` + test (foreign_keys pragma), `packages/cli/src/capsule.ts` (same-volume staging, stricter capsule/manifest validation — partially overlapping files with this step's edits), `packages/adapter-pi/test/deferred*` (fixture/test hardening). All included in the passing 115-test run; committed together with explicit attribution in the commit message.

## Known limitations / remaining risks

- Parked-state recovery on the *next import* is automatic, but a manual `mv` is still the documented escape if no further import is attempted; doctor during a parked window sees an empty Relay state (probe-created), which is safe by definition (no new state exists) but worth an operator note.
- `after-relay-commit` death leaves `.relay.pre-import-old` on disk until the next import; disk usage, not correctness.
- Contract path collision edge: when `--storage` points directly into a workspace root (not under `.relay`), resolution level 2 equals level 3 — same file, harmless.
- Node 24 + real-provider deferred evidence remain Step 2 scope. No push, no publish; Steps 2–4 not started.
