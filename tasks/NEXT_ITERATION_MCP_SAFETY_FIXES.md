# MCP safety review — fix before Step 6/7

Review date: 2026-09-24. Target: `d9b4bd8`. This is a local handoff; do not
start public CI/release work, push, or publish in this iteration.

## Verified baseline

- WSL / Node 22: `corepack pnpm check` — 125 pass, 0 fail, 0 skipped.
- WSL: `node examples/crash-demo.mjs` — four assertions PASS; remote counter 1.
- Windows / Node 24 full check was not obtained in this review: WSL-created
  `node_modules` reparse points prevented Windows `tsc`; a frozen pnpm install
  failed with `EACCES` on `node_modules/typescript`. Do not call this a source
  test failure or a Node 24 pass.
- Working tree was clean at review start. The current MCP tests cover a live
  owner and sequential dead-owner takeover, not concurrent successors or
  concurrent calls through one owner.

## Required fixes, in priority order

1. **Single-owner acquisition must remain true after takeover.** In
   `packages/mcp/src/lock.ts:102-111`, two successors can both read the same
   stale lock, then each rename and verify at different times; both may
   return `acquired`. `settleMs` is a delay, not fencing. The read-then-remove
   release in `:114-119` can also delete a successor's lock. Design one
   cross-process ownership mechanism that makes these races impossible or
   fails closed, including process death. Test two independent successors
   racing for one stale workspace and an old owner releasing during takeover.
   Include PID reuse and malformed lock data in the fail-closed design; the
   current `startedAt` is stored but not checked. Do not rely on SQLite's
   unique effect key as a replacement for ownership.
2. **Serialize effect handling within the owner.** `runStdioServer` starts each
   `handleLine` without awaiting it (`packages/mcp/src/server.ts:370-372`).
   Two calls with the same operation ID can therefore overlap. Reproduced in
   review: hold the first provider POST before commit; a second submit sees
   `SUBMITTED`, reconcile says not found, marks the journal `FAILED`; the first
   POST then commits remotely, but its `markConfirmed` fails. Result: remote
   counter 1, journal `FAILED`. Add a deterministic regression test and make
   same-key calls linearizable. A not-found observation while another local
   execution is in flight must not settle the operation as FAILED.
3. **Make `relay_reconcile_operation` truly non-creating.** In
   `packages/mcp/src/server.ts:315-329`, calling it for an absent key invokes
   `runEffect`, which creates a PREPARED row, then marks it FAILED through the
   placeholder `execute` callback. This was reproduced: `get` returned
   `not found` before reconcile and `FAILED` after. A PREPARED row follows the
   same erroneous path. Look up and validate the existing record first;
   absent/PREPARED should produce an explicit result with no new row or remote
   action. Test both paths.
4. **Classify provider outcomes conservatively.** `server.ts:266-279` treats
   every HTTP 4xx as a definitive pre-commit failure. A provider can commit an
   operation and still answer with an error, or a proxy can return an
   ambiguous status. Default to UNKNOWN unless the configured provider
   contract proves rejection. Add tests for a provider that commits then
   returns 409/408 and for a request that never responds; bound fetch timeouts
   without turning timeouts into definitive FAILED.
5. **Bind recovery to a stable, observable operation.** The tool only accepts
   a model-supplied `operationId`; `relay_list_unresolved` returns only
   `key/status/updatedAt` (`server.ts:304-312`). Preserve structured actionId,
   operationId, and enough non-secret intent information for a fresh session
   to choose the existing operation. Do not claim that a skill instruction
   guarantees ID reuse. Validate that configured execute/reconcile endpoints
   actually bind the operation ID, and bind the journal request identity to
   any action configuration that changes remote meaning. Test a config change
   and a fresh session recovering from the list.

## Evidence and wording corrections

- `reports/PUBLIC_PROOF_RESULT.md:7` names baseline commit `3f18e2f`, while
  Git history has `3ade92d`; correct the report.
- The report at `:39` says WSL bridging is documented in both host READMEs,
  but both current READMEs show native Node commands. Make the tested path
  reproducible and distinguish generated local `.mcp.json` from tracked files.
- Retain the narrow promise: only actions actually executed through Relay are
  covered. A model-visible tool or hook does not intercept arbitrary shell,
  built-in, or other MCP actions.

## Acceptance and stop point

- New tests fail on the current code for the takeover race, concurrent same-key
  false failure, absent/PREPARED reconcile mutation, and ambiguous HTTP status;
  they pass after the smallest corresponding fixes.
- Repeat the full test suite, crash demo, two-process lock test, and at least
  one actual Claude Code and Codex tool call against the fixed server. Record
  exact versions, commands, outputs, pass/fail/skip counts, and any host
  approval or WSL bridge settings without secrets.
- Write `reports/MCP_SAFETY_REVIEW_RESULT.md` separating implementation,
  reproducible local evidence, actual host calls, and remaining limitations.
  Stop for review before Step 6/7, remote creation, push, or publication.
