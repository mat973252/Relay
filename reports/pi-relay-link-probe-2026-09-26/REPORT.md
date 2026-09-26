# Pi → Relay MCP effect linkage probe (evidence-only)

Date: 2026-09-26 (UTC). Relay source: `8e877a93b5f6caafd98d06b0f2a1546e7b6a356d` (main at probe time).
Task: `tasks/NEXT_ITERATION_PI_RELAY_LINK_PROBE.md`. This report changes no Relay or AgentLens product code, does not advance Step 6/7 or AgentLens M8, and leaves the Relay overall safety gate **CLOSED**.

## Question

Can an **actual isolated Pi tool invocation** of Relay's MCP action be linked to an **actually committed** Relay effect event by exact non-secret `actionId` + `operationId` — using Pi's public session/tool APIs and without inferring association from time, directory, or model prose?

## Verdict

**Yes — within the stated setup, the link is proven by exact values, not proximity.** One caveat is structural: Pi 0.87.0 has **no built-in MCP client**, so the Pi side must reach Relay's MCP server through a bridge registered via Pi's public custom-tool API (`customTools` / `pi.registerTool`). The probe built that bridge; it faithfully forwards the model's persisted tool-call arguments verbatim. The link that was proven is:

```
session JSONL toolCall.arguments = {actionId, operationId}
        ⟶ relay journal key = "actionId:operationId"  (exact string)
```

and the correlation was verified against real commits on a loopback provider counter.

## Environment and exact commands

- Node `v24.19.0` (`node --version`), linux x64, `pnpm 10.33.0`.
- Pi `@earendil-works/pi-coding-agent` **0.87.0** and `@earendil-works/pi-ai` **0.87.1** (from `packages/adapter-pi` devDependencies; `pi.VERSION` observed at runtime).
- Build: `pnpm install --frozen-lockfile` then `pnpm --filter @relay/cli exec tsc -b` (known project-reference ordering issue documented in `reports/INDEPENDENT_EFFECT_HISTORY_ACCEPTANCE_2026-09-26.md`), then root `pnpm typecheck` passed.
- Run: `RELAY_SOURCE_SHA=$(git rev-parse HEAD) node reports/pi-relay-link-probe-2026-09-26/probe/probe.mjs <outDir>`
- Probe script SHA-256: `88b3f4d3fb97e90150b9092a04692a1f300f9c7df7236e8f12a11d4674f814b7` (`probe/probe.mjs`).

No real model service, no user Pi session, no credentials, no production journal, no non-loopback provider. All workspaces, session dirs, and SQLite journals were `mkdtemp` disposables; the probe exits without retaining them in the repo. `node:sqlite` was used read-only to inspect the journal after each scenario.

## Setup (all public surfaces)

| Component | What it is |
| --- | --- |
| External effect | Loopback HTTP counter provider on `127.0.0.1` (commit-then-answer `POST /increment`, found-flag reconcile `GET /effects/{operationId}`, observed `requests()` and `counter`). Modelled on `packages/mcp/test/fixtures/mini-provider.ts`. |
| Relay MCP server | The **unmodified product binary** `packages/mcp/dist/src/main.js --workspace <tmp>` speaking JSON-RPC stdio MCP; initialize reported `serverInfo {name: "relay", version: "0.1.0", ownership: "acquired"}` and offered `relay_submit_action`, `relay_list_unresolved`, `relay_reconcile_operation`, `relay_get_operation`. |
| Pi agent | `createAgentSession` with `ModelRuntime.create({refreshOnCreate:false})` + `registerNativeProvider(fakeProvider)`, `SessionManager.create(workspace, sessionDir)` for real JSONL persistence, `noTools:"builtin"`, `customTools:[...]` bridge tools. Pattern follows `packages/adapter-pi/test/fixtures/deferred-child.ts` (public APIs only). |
| Fake model | Deterministic native provider (`api: "relay-probe-api"`, `provider: "relay-probe-fake"`, `model: "relay-probe-deterministic"`) emitting a scripted `toolCall` content block with a probe-generated `toolCallId`, then a `stop` text. Its `auth.resolve` returns the literal placeholder `"relay-probe-not-a-secret"`; no credential is involved. |
| MCP bridge | One Pi custom tool per relay MCP tool, registered via `defineTool`/`customTools`. `execute(toolCallId, params)` sends `tools/call {name, arguments: params}` verbatim to relay-mcp and returns the MCP content as the tool result. This stands in for the host-side MCP client Pi lacks. |

Pi documentation consulted: `docs/sdk.md` (customTools, SessionManager, ModelRuntime), `docs/session-format.md` (ToolCall/ToolResultMessage/entry tree), `docs/custom-provider.md` (`registerProvider`), `docs/usage.md` (explicitly excludes built-in MCP — verified by code inspection of `dist/`).

## Observations (evidence.json, generated 2026-09-26T01:11:27.434Z)

### Scenario "success"

- Pi session `01a0db44-6244-708e-8283-322db59a09dc`, session file SHA-256 `0552c5b8f84b6af9…` (full values in evidence.json).
- Persisted assistant `toolCall`: id `probe-call-17ff6d5e-e255-454f-bc06-8f1069d6f163`, name `relay_submit_action`, arguments `{actionId:"counter-increment", operationId:"probe-success-4f2814e3", intent:"probe: increment loopback counter once"}` — exact argument match with what was requested.
- Persisted `toolResult` (same `toolCallId`, `toolName:"relay_submit_action"`, `isError:false`):
  `{"status":"confirmed","key":"counter-increment:probe-success-4f2814e3","result":{"ok":true,"value":1},"deduplicated":false,"reconciled":false}`
- Journal `relay_effects` row: `key = "counter-increment:probe-success-4f2814e3"`, `kind="mcp:counter-increment"`, `status="CONFIRMED"`, `request_hash=af2fa677…` — one row, exact key equality.
- `relay_effect_events` (columns `seq, effect_id, key, kind, from_status, to_status, cause, at`): `- -> PREPARED (prepare)` → `PREPARED -> SUBMITTED (submit)` → `SUBMITTED -> CONFIRMED (execute)`, all three rows carrying the same `key` and the row's `effect_id`.
- `relay effects --history` (run against the disposable workspace) printed the same key and sequence, `history=observed`.
- Loopback provider: `counter` incremented once; `POST /increment?operationId=probe-success-4f2814e3` observed.

### Scenario "ambiguous" (commit-then-error)

- Session `…-322ef0f6df46`; toolCall arguments `{actionId:"counter-increment-ambiguous", operationId:"probe-ambiguous-4f2814e3"}`.
- Persisted toolResult `isError:false` with text `{"status":"unknown","key":"counter-increment-ambiguous:probe-ambiguous-4f2814e3","reason":"ambiguous: provider answered HTTP 503 …"}` plus the "OUTCOME AMBIGUOUS — do NOT resubmit" instruction.
- Journal row `status="UNKNOWN"`, `settled_at=NULL`, `has_reason=1`, `has_result_json=0`; events `PREPARED -> SUBMITTED -> UNKNOWN (execute)`.
- Provider committed (`POST /increment-ambiguous` observed; counter incremented) — tool result and journal **agree**: the link survives a pending/unknown outcome and correctly does not claim confirmation.

### Scenario "two-calls" (discrimination control)

One session (`01a0db44-634d-…`), one workspace, one journal, two `relay_submit_action` tool calls within ~90 ms of each other:

- `probe-alpha-…` → journal key `counter-increment:probe-alpha-4f2814e3` → CONFIRMED, events seq #1–#3, effect_id `8de4fea4…`.
- `probe-beta-…` → journal key `counter-increment:probe-beta-4f2814e3` → CONFIRMED, events seq #4–#6, effect_id `e715fec9…`.
- Provider counter final = 4 total across all scenarios; committed operation ids exactly the four requested.
- Notably, beta's `prepare` and `submit` events share the **same millisecond** (`at=…344`) — timestamp proximity could not disambiguate these; the `actionId:operationId` key did.

## What the evidence proves, and what it does not

**Proven here:**
1. Pi persisted the exact non-secret `actionId`/`operationId` in the session JSONL tool call, and the toolResult entry is keyed back to that call by `toolCallId`.
2. Relay's MCP server journaled the same pair as key `actionId:operationId` on a real committed effect — confirmed by the loopback provider's counter and request log.
3. Tool result and journal agree on success (CONFIRMED) and on ambiguous outcome (UNKNOWN, not settled, isError=false in the Pi record since MCP returns the ambiguity as content, not a protocol error).
4. The correlation discriminates by argument values: two calls in one session produced two exactly-keyed effect rows; the journal rows share no Pi identity, so the key is doing all the work.

**Not proven / limitations:**
- **No native MCP path in Pi 0.87.0.** Pi deliberately ships no MCP client (`docs/usage.md`: "It intentionally does not include built-in MCP"); the link was exercised through the public `customTools`/`pi.registerTool` surface. A different host MCP bridge that rewrote arguments would break the association silently — Relay's journal stores no Pi session/tool-call id, so the link is **unidirectional**: session → journal, never journal → session. `relay_effects`/`relay_effect_events` carry no session reference (column sets recorded in evidence.json).
- The fake model deterministically selected arguments; no claim is made about a real model choosing or honoring the ids, nor about prompt-driven `relay_list_unresolved` reuse.
- `intent` was stored verbatim in `intent_json` — the probe used a non-secret string as instructed; this field is a secrecy footgun for real use, unchanged from product behavior.
- A linked effect does **not** imply Run/Step/Recovery coverage, capsule exportability, or real-provider completion; loopback found-flag reconcile is not a real provider contract. The Relay overall safety gate remains **CLOSED**; this stage does not claim Step6/7 or AgentLens M8.

## Files

- `probe/probe.mjs` — the complete one-off probe (SHA-256 `88b3f4d3…`).
- `evidence.json` — full sanitized observations: session ids/files, hashes, entry summaries, journal dumps (free-form `reason`/`result_json`/`remote_ref` reduced to presence flags), provider counter, link checks, and `relay effects --history` output.
