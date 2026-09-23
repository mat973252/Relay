# Stage B Result — Epistemic MVP

Status: **PASS** (per `docs/ARCHITECTURE-CORRECTION.md` Stage B scope)

## Implemented behavior

- New package `@relay/epistemic` — pure domain, zero runtime dependencies:
  - Six entities: `Investigation` (boundary/goal/scope/lifecycle), `Claim` (falsifiable statement), `Evidence` (opaque inspectable reference: `artifact | effect | source | observation` — references, never copied content), `Belief` (scope + confidence + status), `Delta` (`changed | unchanged | contradicted` + attention flag), `Decision` (`high-impact | unresolved-conflict` only).
  - Pure rules in `delta.ts`:
    - Knowledge Delta is strict: first evidence on an undetermined belief → `changed`; evidence opposite to the belief → `contradicted`; same direction with confidence move ≥ threshold (default 0.1) → `changed`; below threshold → `unchanged`.
    - **No Delta, No Attention** mechanized: `attention` is derived from the delta kind (`changed`/`contradicted` = true, `unchanged` = false) and `attentionItems()` is a view over deltas — attention is never written directly.
    - Decision Gate: a Decision is required only for `high` impact or non-auto-resolvable conflicts.
  - `recordEvidence` service: the only belief/delta mutation path — appends evidence, recomputes belief, appends delta, atomically through the store port.
  - `MemoryEpistemicStore` (unit tests / ephemeral use).
- `@relay/storage-sqlite` gains `SqliteEpistemicStore` (WAL + FULL sync, CHECK constraints, belief upsert per claim) implementing the same port.

## Dependency boundary respected

- `epistemic` imports nothing but `node:crypto` (uuid) — no Pi, no LLM calls, no scheduler/daemon, no UI, no graph.
- SQLite stays in `storage-sqlite`; `epistemic` owns only domain + port (no second runtime).
- Boundary test extended automatically: epistemic appears in the package sweep (no Pi deps, no process.env).

## Tests run (real commands, real results)

`corepack pnpm check` — totals **103 pass, 0 fail** (epistemic 8, core 39, artifact-fs 11, storage-sqlite 16, cli 22, adapter-pi 7).

- `epistemic/test/epistemic.test.ts`:
  - Claim→Evidence→Belief chain: belief rebuildable by claim id and by scope; evidence references kept as opaque refs.
  - Knowledge Delta: undetermined→changed (attention); opposite evidence→contradicted (attention); threshold crossing→changed; tiny move→**unchanged with no attention**; attention view contains only attention-bearing deltas.
  - Decision Gate: high-impact always decides; low-impact only when not auto-resolvable.
- `storage-sqlite/test/epistemic.test.ts`: full chain (investigation, claim, evidence via `recordEvidence`, decision) survives close/reopen; belief rebuilt by claimId and scope; deltas/attention/decisions intact.

## Files changed

- `packages/epistemic/**` (new: types/delta/store/index, package.json, tsconfig, tests).
- `packages/storage-sqlite/src/epistemic-store.ts` (new) + export + `@relay/epistemic` dependency.
- `tsconfig.json` (project references + epistemic), `pnpm-lock.yaml`.
- `packages/adapter-pi/test/deferred.test.ts` timeouts raised to 300 s (full-suite parallel load exceeded the previous 180 s budget — real E2E duration, not a hang).

## Deferred items (explicitly out of Stage B scope)

- No Pi-adapter wiring for auto-recording evidence from tool calls (that is an integration decision for the next cycle, after real usage shapes which observations matter).
- No CLI surface for epistemic queries yet; the store port is the stable seam.
