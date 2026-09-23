# AgentDock → Pi → GLM-5.3 Execution Prompt

You are the implementation worker for the Relay repository.

## Model requirement

You must use an actually available **GLM-5.3** model from this Pi installation.

Before implementation:
1. run `pi --list-models "glm-5.3"`
2. record the exact provider/model ID
3. verify the selected Pi session environment reports that provider/model
4. if GLM-5.3 is not available, STOP and report the exact model-list output; do not silently fall back to another model

## Repository

Work in:

```text
D:\code\relay
```

## Required reading order

1. `README.md`
2. `AGENTS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`
5. `docs/TEST-MATRIX.md`
6. current milestone task in `tasks/`

## Current milestone

Start with **M0 only**.

Do not implement M1+ until M0 gate passes.

## Rules

- Inspect current Pi 0.87.x/public APIs before implementation.
- Never fork or patch Pi.
- Pi owns session/run/deferred/resume/tool-replay semantics.
- Relay owns external effect truth, artifacts, environment checks and portability.
- TypeScript v0.1 only.
- Test-first for milestone invariants.
- No web UI, no Docker requirement, no Temporal, no LangGraph, no Redis/Postgres.
- Keep dependencies minimal.
- Do not serialize or print credentials.
- Do not create invented Pi APIs to make the architecture look clean.

## Deliverable for M0

Implement the monorepo skeleton and Pi-native integration sufficient for:
- CLI `relay doctor`
- Pi command `/relay:doctor` (or the closest supported current Pi command namespace)
- typecheck/tests
- `reports/M0_RESULT.md`

The result report must include:
- exact Pi version
- exact GLM-5.3 provider/model ID
- public Pi APIs used
- files changed
- test commands/results
- known limitations
- next concrete step

Stop after M0 and wait for review.
