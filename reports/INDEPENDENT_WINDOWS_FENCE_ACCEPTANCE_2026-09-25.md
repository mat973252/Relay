# Independent Windows fence-transfer acceptance

Date: 2026-09-25. Scope: Devin PR #2, `devin/safety-windows-fence` at `9605298778147d3ebb41eac80f38a27374d84521`, merged into `main` as `58825ad841c11e0a579fe540a68d0099c80612b4`.

## Result

The Windows dead-claimant fence-transfer repair is accepted for this stage. The original native Windows `EPERM` regression no longer reproduces in the targeted two-process test. The follow-up also fixed a Windows path-separator error in the simulated install-denial test and added a deterministic changed-lock case. This acceptance does **not** clear Relay's overall safety review, authorize real external effects or Step 6/7, or establish an AgentLens M8 event source.

## Independent evidence

- Fresh Windows checkout, Node 24.13.0, pnpm 10.33.0: `pnpm install --frozen-lockfile` and TypeScript build/typecheck passed. The targeted `packages/mcp/dist/test/lock.test.js` passed 16/16 twice, including two-process succession, simulated Windows `EPERM`, transient install denial, swapped live owner, dead-claimant chain, and live-claimant fail-closed cases. `pnpm --filter @relay/mcp test` passed 46/46. No real provider was called.
- Windows workspace-wide `pnpm test` stops at the pre-existing core boundary test because its path comparison rejects Windows `packages\\cli\\src\\env.ts`; the changed PR does not touch that test. The standalone Windows crash demo stops at its POSIX `SIGKILL` signal assertion even though the fake provider reports a commit; this is not evidence of a Relay effect failure and is not counted as a passing Windows crash demo.
- Fresh WSL Ubuntu checkout at the same PR head: frozen install, TypeScript build/typecheck, full workspace test suite, and `node examples/crash-demo.mjs` passed under Node 22.18.0. The same install/typecheck/full suite/crash demo passed under Node 24.4.1. Both runs used only local disposable workspaces and the loopback fake provider.
- Source review checked the append-only exclusive hard-link claim chain, bounded install retries, stale-body recheck, changed-lock refusal, post-install authority check, and that the sweep excludes `mcp-owner.claim.*`. The new regression explicitly swaps the lock to a live owner during the injected install failure and verifies that no second rename or release clobbers it. `git diff --check` passed. The PR changes only the MCP lock implementation/tests and its result report.

## Remaining limits

- The claim chain relies on local filesystem hard-link and rename semantics; it is not distributed locking. Cross-host ownership remains fail closed.
- The Windows workspace-wide test and crash-demo harness limitations above are still present and should be handled in separate, scoped work if Windows-wide green is required.
- Relay's effect journal retains current effect status rather than a complete Run/Step/Recovery event history with a stable Pi association key. AgentLens M8 cannot present missing events as observed production trace.
- Keep Step 6/7, real external effects, package publishing, and AgentLens M8 blocked until their separate safety and data-source gates are independently met.
