# M5 Result — Deferred Migration

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- `packages/adapter-pi/src/deferred.ts`:
  - `discoverDeferred(sessionDir)`: read-only scan of Pi session JSONL files (documented `relay session format`, stopReason `deferred` + `DeferredHandle`) returning `{sessionFile, sessionId, entryId, handle}`.
  - `createMockDeferredProvider({baseUrl})`: a native Pi `Provider` (pi-ai contract) whose `stream()` submits exactly one job to a local job server and returns a genuine DEFERRED `AssistantMessage`, and whose `fetchDeferred()` polls the SAME job id — the provider contract for deferred responses, never a resubmission.
  - `mockDeferredModel()`: the provider's `Model` (custom API id `relay-mock-jobs`, permitted by `Api = KnownApi | (string & {})`).
- Capsule: `extraAdapterFiles` export option packs arbitrary adapter material under `relay-capsule/adapter/**`; import extracts `adapter/**` into `<target>/.relay/adapter/` (Pi session files travel inside the capsule, hashed like every other file).

## API decisions (verified against installed Pi 0.87.0 before coding)

- Pi 0.87 public deferred surface: `DeferredHandle {provider, modelId, api, id, expiresAt?, pollAfterMs?, data?}` and provider `fetchDeferred` (pi-ai), `ModelRuntime.registerNativeProvider/streamDeferred/fetchDeferred/cancelDeferred`, `createAgentSession`, `SessionManager.create/open` (pi-coding-agent public index). No AgentSession-level "resumeDeferred" exists in 0.87; Pi persists deferred assistant messages in the session transcript as the durable representation.
- Relay therefore owns only: discovery (documented format), migration (capsule), and resume-glue that calls Pi's `ModelRuntime.fetchDeferred`. No Relay DeferredHandle, no replay engine, no session emulation.
- `adapter-pi` now declares `@earendil-works/pi-ai` directly (same store instance as pi-coding-agent — no dual-package hazard); boundary test still confines Pi-family deps to adapter-pi.
- Capsule mechanics stay in `@relay/cli`; adapter-pi uses them test-only (devDependency).

## Tests run (real commands, real results)

`corepack pnpm check` — totals **89 pass, 0 fail** (core 39, storage-sqlite 15, artifact-fs 11, cli 18, adapter-pi 6).

New `adapter-pi/test/deferred.test.ts` (real E2E, roadmap M5 gate):

1. Machine A child process: `ModelRuntime.create` + `registerNativeProvider(mock)` + `SessionManager.create` + `createAgentSession` + `prompt()` → real Pi session file persists an assistant message with `stopReason: "deferred"` and handle `job-1`; **submissions == 1**.
2. Relay `discoverDeferred` finds the handle in the session dir.
3. Capsule export (session file as adapter material + adapter context) → import into machine B; migrated session file is byte-identical.
4. Machine B child process (fresh process — restart count ≥ 1): `SessionManager.open` inspects the migrated session, then `ModelRuntime.fetchDeferred(handle)` resumes → final message `stopReason: "stop"`, text `job-1 finished: 42`.
5. Gate assertions: `submissions() === 1` across submit+migrate+resume, migration count 1, remote job completed only after target-side resume.

Fixes during the milestone: replaced a `createRequire` hack that could not load ESM-only pi-ai (surfaced as a swallowed provider error — diagnosed via direct `ModelRuntime.complete`); aligned mock provider routes.

## Files changed

- `packages/adapter-pi/src/deferred.ts` (new, exported), `packages/adapter-pi/src/index.ts`.
- `packages/adapter-pi/package.json` (+`@earendil-works/pi-ai`, +`@relay/cli` devDep), `packages/cli/package.json` (exports map incl. `./capsule`).
- `packages/cli/src/capsule.ts` (`extraAdapterFiles`, adapter extraction on import).
- Tests/fixtures: `packages/adapter-pi/test/fixtures/job-server.ts`, `deferred-child.ts`, `packages/adapter-pi/test/deferred.test.ts`.

## Gate check

- provider submission count == 1 — **PASS**
- process restart count >= 1 — **PASS** (two distinct child processes)
- migration count >= 1 — **PASS** (capsule A→B with session file)
- remote job completes after target-side Pi resume — **PASS** (`fetchDeferred` → `stop`, result text asserted)

## Next milestone blockers

None. M6 (chaos gate: crash matrix consolidation + capsule corruption + secret sweep across all boundaries) remains for v0.1 RC.
