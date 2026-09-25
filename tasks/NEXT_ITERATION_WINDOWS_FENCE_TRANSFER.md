# Windows dead-claimant fence transfer — safety stage

Date: 2026-09-25. Start from main commit `40b0ec1` or its current descendant. This stage addresses the independently reproduced Windows lock takeover failure only. Keep Step 6/7, real external effects, package publishing, and AgentLens adapters stopped.

## Reproduction and risk

On Windows Node 24.13, the test `dead-claimant fence recovery never leaves the succession unprotected; an attempt fired inside any gap cannot leapfrog` in `packages/mcp/test/lock.test.ts` fails repeatedly. The spawned child receives `EPERM` at `rename(claimantTmp, fence)` in `packages/mcp/src/lock.ts`, then the test times out because the child never reports. The failure was independently reproduced in both PR #1 and a separate checkout of its unchanged base commit; PR #1 did not touch the lock module. WSL Ubuntu Node 22/24 full suites, including the lock tests, passed. This is an unresolved Windows portability and ownership-safety gap, not evidence that two owners occurred.

The current protocol intends a dead claimant's fence to be transferred without an interval where the stale lock has no succession fence. A replacement strategy must preserve that invariant, fail closed on errors and unattributable owners, and never delete or overwrite another live owner's lock or fence.

## Work and acceptance

1. Reproduce the Windows failure in a clean checkout if Windows is available. If the Devin VM is Linux-only, use the independent Windows error above as the reproduction evidence; build a deterministic local regression or filesystem-injection case that exposes the same transfer failure before the fix. Explain the filesystem semantics and label simulated evidence as simulated. If a safe repair cannot be established, report the blocker and stop rather than guessing.
2. Implement the smallest safe cross-platform repair in the lock protocol and its tests. Test concurrent claimants, a dead claimant, a live claimant, release/takeover races, crash litter, and the opportunist watcher. The success condition is exactly one owner, continuous protection during transfer, and no silent fallback that weakens the fence. If Windows cannot provide the necessary atomic operation, document that limit and fail closed; do not claim Windows takeover support.
3. Use disposable local directories only. Run frozen install, typecheck, the targeted lock test repeatedly, full MCP and repository suites, and crash demo on available Node 22/24 environments. Codex will perform the independent Windows runs before merge. Record exact commands, versions, pass/fail counts, and remaining limits. Do not call a real provider.
4. Commit/push one `devin/safety-windows-fence` branch, create a PR against main, and stop for independent Codex review. Do not merge or claim the Relay safety gate cleared.

Keep the pending-outcome repair from PR #1 intact. Do not bundle the pre-existing package build-order issue or AgentLens event-source work into this stage.
