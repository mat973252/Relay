# Relay

**Durable execution continuity for AI agents.**

Relay is an independent execution-continuity project whose first reference integration is built on **Pi AgentHarness**.

Relay does **not** reimplement Pi's agent loop, session tree, suspended runs, deferred model calls, resume semantics, or tool replay policy. Instead, Relay extends Pi across the boundaries Pi should not have to own by itself:

1. **External Effect Safety** — know whether irreversible outside-world actions actually happened.
2. **Artifact Lineage** — keep important outputs outside chat context with traceable provenance.
3. **Capability Contract** — verify a restored environment can really continue the work.
4. **Portable Capsule** — export/import the durable execution context across controlled machine migration.

## Core principle

> Pi owns agent execution semantics. Relay owns continuity with the outside world.

## v0.1 scope

Relay v0.1 proves four milestones:

- **M0 — Native integration:** load as a Pi package/extension without forking Pi.
- **M1 — Crash-safe effects:** unsafe external effects are never silently duplicated.
- **M2 — Durable artifacts:** outputs survive outside conversation context with lineage.
- **M3 — Portable execution:** export on machine A, import on machine B, validate capabilities, and resume with Pi.
- **M4 — Deferred migration:** a Pi suspended/deferred operation is resumed without submitting the remote job twice.
- **M5 — Chaos gate:** crash-injection matrix passes at critical boundaries.

## Language

- TypeScript 5.9+
- Node.js 22/24
- SQLite for Relay effect journal
- Filesystem + SHA-256 content-addressed artifacts
- YAML capability contract
- tar.gz capsule format for v0.1

No Java/Go/Rust in v0.1.

## Local target

Default personal workspace:

```text
D:\code\relay
```

See `AGENTS.md` and `tasks/` before implementation.
