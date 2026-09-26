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

## Local workspace

Everything runs from the repository root; no machine-specific paths are embedded:

```powershell
corepack pnpm install
corepack pnpm check   # typecheck + tests
node packages/cli/dist/src/cli.js doctor
```

The M0 bootstrap script derives the repository root from its own location:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-relay-m0.ps1
```

See `AGENTS.md` and `tasks/` before implementation.

## The one-sitting proof (no Pi, no model account, no Docker)

```bash
corepack pnpm install && corepack pnpm typecheck   # build once
node examples/crash-demo.mjs
```

Expected tail of the output: a child process is force-killed **after** the local
HTTP counter has committed but before any local confirmation; on restart the
same operation id replays, Relay asks a read-only reconciliation question,
and the assertions print `PASS` seven times with both the remote counter and
submit-request count at exactly 1. Real guarantee: **no silent retry of an ambiguous unsafe action** —
stronger guarantees need downstream idempotency or a reliable reconciliation
query.

## MCP entry points (Claude Code, Codex, Pi)

`packages/mcp` exposes the same effect engine as a local stdio MCP server:

- only explicitly configured actions run (`<workspace>/.relay/mcp-actions.json`,
  schema `relay.mcp-actions/1`) — destinations and credentials never come from
  model text;
- one live server per workspace (single-writer lock; a second one fails
  closed until the first exits; the lock is recoverable after process death);
- unresolved operations are listable so fresh sessions reuse operation ids.

Host entries: `hosts/claude-code/relay-effect-guard` and
`hosts/codex/relay-effect-guard` (verified by real tool calls from both hosts
on one shared workspace). Protection applies **only** to actions executed
through the relay tools; raw shell/HTTP, built-in tools, and other MCP
servers are outside the guarantee.

## Status export (mat-console)

`relay status` emits a `mat-console.status/1` JSON document from a strictly
read-only open of the local effect journal — aggregate counts and attention
items only, no effect keys/ids/payloads. See `docs/STATUS-EXPORT.md`.
