# Public Proof Result — Shared MCP Boundary (Steps 1–5)

Status: **Steps 1–5 complete, stopped for review** per `tasks/NEXT_ITERATION_PUBLIC_PROOF.md`. No push, no publish, no remote.

## Implementation

1. **Review baseline closed** (commit `3f18e2f` message aside — see git log): the three uncommitted review files landed as their own commit — overwrite protection now covers any `.relay` state (artifacts/contract without effects), parked-state restore happens before the overwrite refusal, the secret claim was narrowed, and the Windows/root `chmod` skip is explicit. Committed only after `corepack pnpm check` passed.
2. **Host-independent demo** — `examples/crash-demo.mjs`: self-contained local HTTP counter (commits BEFORE answering, holds the response), real child-process SIGKILL after the remote commit, restart with the same semantic operation id, read-only reconciliation, four hard assertions (counter === 1, journal CONFIRMED, reconciled=true, precondition that death happened after commit). Runs on Node alone. README links it with the exact command and the honest guarantee statement.
3. **MCP vertical slice** — new package `@relay/mcp` (`packages/mcp`):
   - stdio JSON-RPC 2.0 MCP server (`initialize` / `tools/list` / `tools/call`), no SDK dependency;
   - four tools: `relay_submit_action`, `relay_list_unresolved`, `relay_reconcile_operation`, `relay_get_operation`;
   - actions come ONLY from `<workspace>/.relay/mcp-actions.json` (schema `relay.mcp-actions/1`); destinations/methods/secret-header references are operator config, never model arguments; secret values flow only into outgoing headers via the package's sanctioned env reader and never into results;
   - UNKNOWN results carry an explicit "do NOT resubmit; reconcile" instruction; `relay_list_unresolved` is designed to be called first so fresh sessions reuse operation ids (the operation identity is the journal key `actionId:operationId`);
   - single-writer ownership lock (`.relay/mcp-owner.lock`): atomic O_EXCL create, live same-host pid => FAIL-CLOSED (no effect tools offered; a `relay_status` tool explains), dead same-host pid => verified takeover, **foreign-host lock => fail closed** (pid checks are meaningless across WSL/Windows on a shared directory; operator removes the lock after confirming the owner is gone);
   - no second journal, no arbitrary-URL proxy, no generic transaction framework.

## Local tests

`corepack pnpm check` on WSL / Node v22.18.0 / Pi 0.87.0 — **125 pass, 0 fail, 0 skipped**:
epistemic 8, core 40, artifact-fs 12, storage-sqlite 17, cli 33, **mcp 8**, adapter-pi 7.

New suites:
- `packages/mcp/test/mcp.test.ts` (5): handshake + exactly-once per operation id (dedup on resubmit, counter stays 1); **crash after remote commit → restart → list unresolved → read-only reconcile → counter stays 1**; second live server FAIL-CLOSED then takeover after owner death; missing actions config => exit 78; unknown action / empty operationId rejected with zero remote executions.
- `packages/mcp/test/lock.test.ts` (3): acquire/release cycle; foreign-host lock stays closed and release never removes someone else's lock; dead same-host lock takeover verifies the new owner.
- Demo (`node examples/crash-demo.mjs`): 4/4 PASS, exit 0 (assertions, not narration).
- Boundary test extended: sanctioned env readers are exactly `cli/src/env.ts` and `mcp/src/env.ts`.

## Real host calls (the actual cross-host loop)

One shared workspace (`/mnt/d/relay-xhost` = `D:\relay-xhost`), one server command (`packages/mcp/dist/src/main.js --workspace …`), one configured action against a live local provider:

| Host | Evidence |
|---|---|
| **Claude Code 2.1.281** (headless `claude -p --mcp-config --strict-mcp-config --allowedTools mcp__relay__relay_submit_action`) | tool result returned verbatim by the model: `{"status":"confirmed","key":"counter-increment:xhost-claude-test-1","result":{"ok":true,"value":1},...}`; provider state `{"counter":1}` |
| **Codex 0.147.0** (Windows, temp `CODEX_HOME`, `codex exec --skip-git-repo-check --approve-for-me`) | model called `relay_list_unresolved` FIRST (skill guidance), then `relay_submit_action` (completed): `{"status":"confirmed","key":"counter-increment:xhost-codex-test-3","result":{"ok":true,"value":1},...}` |

Also observed live, unplanned: when the Claude Code session's MCP process was still holding the workspace, **Codex's server instance correctly failed closed** ("another MCP process owns this workspace") and executed nothing (counter 0) — the single-writer boundary demonstrated across hosts by accident. A direct fetch failure mid-call correctly surfaced as `UNKNOWN` ("do not resubmit") rather than a retry.

Practical notes recorded for operators: Windows hosts cannot resolve WSL-created pnpm symlinks, so the verified host configs spawn the server through `wsl.exe` (documented in both host READMEs); Codex needs `--approve-for-me` (MCP calls are approval-gated by default — the earlier "user cancelled MCP tool call" failures were the approval policy, not the server).

## Host entries

- `hosts/claude-code/relay-effect-guard/`: plugin layout (`.claude-plugin/plugin.json`, generated `.mcp.json`, `skills/relay-safe-actions/SKILL.md`), `install.mjs` generator, README with the exact verified headless command and honest coverage statement.
- `hosts/codex/relay-effect-guard/`: `config-snippet` procedure for a clean `CODEX_HOME` profile, same SKILL guidance, README documenting the verified command incl. `--approve-for-me` and the wsl.exe bridging reason.
- Both state explicitly: protection covers only actions executed through the relay tools; raw shell/HTTP, built-in tools, and other MCP servers are bypasses, and installing a plugin intercepts nothing.
- Pi remains the native reference adapter (unchanged this iteration).

## Release readiness (NOT done, by instruction)

No LICENSE chosen, no CI matrix, no published packages, no remote, no push, no external-user verification. Node 24 was used only incidentally (the Windows-side node that runs under `wsl.exe` bridging is v24.13.0 for the MCP server process in the Codex path); a hosted Node 22/24 × Windows/Linux matrix remains Step 6. Capsule secret-claim narrowing (Step 7) is partially reflected in code comments from the review baseline but the README/report wording sweep is not done.

## Files changed this iteration

- New: `examples/crash-demo.mjs`, `packages/mcp/**` (actions/lock/server/main/env + tests + fixtures), `hosts/claude-code/relay-effect-guard/**`, `hosts/codex/relay-effect-guard/**`, `tasks/NEXT_ITERATION_PUBLIC_PROOF.md`.
- Modified: `packages/core/test/boundary.test.ts` (sanctioned env readers), `README.md` (demo + MCP sections), `tsconfig.json` / `pnpm-lock.yaml` (mcp project), `.gitignore` untouched.
- Baseline commit (separate): the three review files enumerated in the task.

## Known limitations / risks

- The takeover race window between two same-host successors is narrowed (write-then-verify with settle) but not formally proven; SQLite key uniqueness plus the PREPARED re-entry contract remain the backstop, and the invariant tests cover the single-owner paths.
- Foreign-host fail-closed requires a manual lock removal after a cross-OS crash; documented, tested for the refusal side only.
- Codex approval semantics differ per version (`--approve-for-me` on 0.147); host README pins the tested flag.
- The demo/MCP provider is deliberately minimal (found-flag shape); real providers need a real reconciliation query, as the README states.
