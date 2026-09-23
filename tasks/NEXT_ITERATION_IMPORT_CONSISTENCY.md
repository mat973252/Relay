# Relay Next Iteration — Import Consistency

## Purpose

This file is the next implementation task for the coding agent. Complete **only Step 1** below, then stop for review. Steps 2–4 are the proposed iteration order, not permission to start them.

Relay is a Pi-adjacent continuity layer. Pi owns the agent loop, session, deferred work, resume, and tool replay. Relay owns external effect truth, artifacts, capability checks, and controlled capsule migration. Preserve the single-writer scope and the `UNKNOWN`-requires-reconciliation invariant.

## Iteration order

1. **Import consistency (execute now):** make capsule state and its imported capability contract one recoverable commit; prove behavior at every interruption point.
2. **Release evidence:** run the current tree on Node 22 and 24; add a real-provider deferred migration exercise when an operator supplies a safe test account; record exact evidence and limits.
3. **Open-source handoff:** prepare a minimal end-to-end failure/recovery example, installation path, CI, and license options. Do not select a license, create a remote, publish, or push without the user's decision.
4. **Stage B integration:** expose evidence capture and a small query surface only after the continuity core and external-user path are credible. Do not build a general knowledge graph or a second Pi state store.

## Step 1 mission

`importCapsule()` currently stages `.relay`, then commits it and `relay.capabilities.yaml` with separate renames (`packages/cli/src/capsule.ts`). A failure or process death between those operations can leave a new `.relay` paired with an old or missing capability contract. The existing C11 matrix tests only the earlier four seams and cannot establish an atomic commit for both pieces.

Make the import outcome **coherent and recoverable** across process death and ordinary filesystem errors. A target must never be treated as ready to resume using a new Relay state with the wrong capability requirements. Keep import separate from activation: `relay doctor` remains the explicit gate before Pi resume.

### Start from the current tree

1. Read `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE-CORRECTION.md`, `docs/TEST-MATRIX.md`, this task, and the relevant source/tests. Inspect current Pi APIs only if a change would touch `adapter-pi`.
2. Run `git status --short` and `git diff --check`. The 2026-09-23 review left local, uncommitted fixes in effect, artifact, SQLite, capsule, and Windows tests. Treat them as the working baseline. Do not reset, overwrite, or silently include unrelated changes in a commit.
3. Run `corepack pnpm check` before editing and record the real result. The last local run on Node 24 passed 107 tests, but rerun it rather than copying that claim.

### Design constraints

- Choose **one authoritative location and commit boundary** for imported Relay state and imported capability requirements. If a root-level `relay.capabilities.yaml` remains supported, define explicitly whether it is a target override, a compatibility copy, or part of the imported state. `relay doctor` must resolve the same contract that the import committed.
- Keep existing valid capsules readable, or document and test a deliberate format migration. Preserve artifact hashes, effect statuses, Pi adapter material, and the ability to inspect a capsule before activation.
- Validate the complete capsule before replacing target state. Stage on the target filesystem so the final rename does not depend on a cross-volume move.
- Do not serialize resolved secret values. A capability file contains references such as environment variable names, not credentials.
- Do not add a generic transaction framework, distributed locks, leases, automatic Pi resume, or a new session/deferred abstraction. Prefer the smallest design that proves the invariant.

### Tests to write first

Extend `packages/cli/test/capsule.test.ts` with a target that already has **old effects, artifacts, and capability requirements**, and a capsule with different new values. Inject failures or child-process death at each relevant boundary:

1. after validation and after complete staging;
2. after parking old state;
3. after installing new Relay state but before capability commit, if the design still has that interval;
4. after capability commit and before cleanup;
5. when the destination capability path is obstructed or unwritable;
6. on the next import/recovery attempt after each interrupted state.

At every point, assert one of two outcomes: the old state and old capability contract remain paired, or the new state and new contract are paired. A parked/recovery state is acceptable only if activation is blocked and a documented, tested recovery action restores one coherent pair. Assert that `relay doctor` never returns READY for a mixed pair. Cover capsules with and without a capability file and both overwrite modes. Keep tests deterministic and free of real credentials.

### Acceptance gate

- The new failure tests fail on the pre-fix implementation and pass on the fix.
- `corepack pnpm check` passes on the current tree. Report Node and Pi versions, per-package test counts, and any environment-specific limitation. Do not claim Node 22 or real-provider coverage unless actually run.
- `git diff --check` passes. Review the final diff for unrelated refactors and credential material.
- Update `docs/TEST-MATRIX.md` and user-facing import/doctor instructions only where behavior or recovery changed. Correct the C11 wording if its guarantee is narrower than previously stated.
- Write `reports/IMPORT_CONSISTENCY_RESULT.md` with the chosen commit model, exact crash points, commands/results, known limitations, and any pre-existing modified files carried through.
- Stop after Step 1. Return a concise file list, test evidence, and remaining risks for review. Do not push, publish, or start Steps 2–4.
