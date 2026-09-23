# Relay Implementation — Stage A: M0 Foundation

You are the implementation worker. Work in the current Relay repository.

Read first, completely:
1. AGENTS.md
2. docs/ARCHITECTURE-CORRECTION.md
3. tasks/M0_BOOTSTRAP.md
4. the installed Pi 0.87.0 docs/source required to implement a real extension, especially docs/extensions.md, docs/sdk.md, package.json exports, and any directly referenced docs.

## Repository reality

The repository currently has NO packages implementation. Baseline history:
- de8afc1 recovered exact original starter
- 5434bea source-grounded architecture correction audit

Do not treat old docs as implemented behavior.

## Product boundary

Pi owns:
- agent loop
- session tree
- suspended/deferred state semantics
- resume semantics
- tool replay semantics

Relay must NOT reimplement those.

Relay owns:
- external effect truth/reconciliation (later stage)
- artifact lineage (later stage)
- capability contract/doctor
- capsule portability (later stage)
- durable epistemic state (next stage)

## First principles to preserve

1. Derived, never narrated.
   State is evidence, not prose. Do not persist progress percentages, code summaries, test claims, or other values that can be recomputed.

2. No documentation duplication.
   Do not create a natural-language mirror of the source tree. Persist only intent, invariants, decisions/tradeoffs, and real test evidence.

3. Persistent Context has a budget.
   Do not create a project-wide spec/context loading system.

4. Do not create Relay versions of Pi Agent Loop, Session, DeferredHandle, Resume, or Replay.

5. Minimal necessary implementation. No microservices, Redis, Kafka, Postgres, Docker requirement, web UI, LangChain/LangGraph, Temporal.

## This stage scope: M0 only

Implement the smallest real TypeScript/pnpm monorepo foundation that proves:
- packages/core
- packages/adapter-pi
- packages/storage-sqlite
- packages/artifact-fs
- packages/cli
- CLI `relay doctor`
- a Pi-visible command `/relay:doctor` or the exact closest public mechanism supported by installed Pi 0.87.0
- actual typecheck and tests

Do NOT implement Effect Guard, Capsule, full Artifact Registry, or epistemic six-entity model in this stage.

## Required corrections in this stage

- Add a practical .gitignore for node/dist/sqlite/env generated material.
- Remove the stale hard-coded repo path:
  - README.md
  - scripts/start-relay-m0.ps1
  - prompts/AGENTDOCK_PI_GLM53.md
  The PowerShell bootstrap should derive repo root from the script location where possible, not embed this machine path as runtime identity.
- Update AGENTS.md minimally with these current invariants:
  - Derived, never narrated
  - No documentation duplication
  - Persistent context budget
  - No Delta, No Attention is reserved for the epistemic stage
  Do not rewrite the whole file.
- Add real root devDependencies/scripts needed for deterministic local builds/tests. Keep dependencies minimal.
- Generate pnpm-lock.yaml.

## Pi API rule

Do not guess API names.
Inspect the locally installed Pi 0.87.0 docs/source first.
Use only public extension/SDK APIs that really exist.
Record exact public APIs used in reports/M0_RESULT.md.

## Design expectations

`@relay/core`:
- pure domain/doctor contracts only
- zero Pi dependency
- deterministic formatting/data model where useful
- no filesystem/process/network assumptions inside the core domain

`@relay/storage-sqlite`:
- M0 only needs a real accessibility/probe boundary suitable for doctor
- prefer node:sqlite only if verified on current runtime
- do not make it a Pi session store

`@relay/artifact-fs`:
- M0 only needs a real artifact-root accessibility/probe boundary
- do not build full lineage yet

`@relay/adapter-pi`:
- the ONLY package that may import Pi packages/types
- expose the real Pi extension entry point/command using public 0.87.0 API
- do not monkey-patch Pi
- do not emulate Pi sessions

`@relay/cli`:
- `relay doctor` must return a machine-checkable exit status and concise human output
- do not print arbitrary environment variables or secret values

## Tests first / acceptance for this stage

Add tests that prove at minimum:
1. core has no Pi dependency
2. adapter-pi is the only package allowed to import Pi packages
3. doctor result is deterministic for injected probe inputs
4. doctor output cannot leak arbitrary secret environment values
5. storage/artifact accessibility probes are real and testable with temp directories
6. Pi extension can be loaded by the installed Pi CLI using its public extension mechanism
7. the registered relay doctor command is verified using the strongest automatable mechanism supported by current Pi 0.87.0; if fully automating slash-command invocation is impossible, prove command registration with the public API plus a real Pi extension load and state the exact remaining limitation.

Run actual commands, at least:
- corepack pnpm install
- corepack pnpm typecheck
- corepack pnpm test
- any real Pi extension load/integration command you identify

Do not hide failures. Fix them if the fix stays inside M0 scope.

## Report

Write reports/M0_RESULT.md containing only durable evidence:
- exact Pi version
- exact provider/model used for this implementation: aisix/glm-5.3
- public Pi APIs actually used, with installed-doc/source references
- commands actually run and exact pass/fail results
- files changed
- limitations / blockers
- next smallest slice

Do NOT claim green without running commands.

## Git

Do not commit. The orchestrator will review the diff and test evidence, then commit if the gate passes.

## Final response

Return:
- what changed
- exact commands/results
- any remaining M0 gate failure
- files requiring orchestrator review

Start immediately. Do not just announce a plan.
