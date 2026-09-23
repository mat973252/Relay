# M0 Result — Pi-native Bootstrap

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- pnpm monorepo with five workspace packages: `@relay/core`, `@relay/storage-sqlite`, `@relay/artifact-fs`, `@relay/adapter-pi`, `@relay/cli`.
- `relay doctor` (CLI): runs three probes — Pi CLI on PATH, SQLite storage read/write via `node:sqlite`, artifact root read/write — and reports deterministic `ok/warn/fail` checks with machine-checkable exit codes (`0 ok | 1 warn | 2 fail | 64 usage`). `--json` emits schema `relay.doctor/1`.
- `/relay:doctor` (Pi extension): the adapter's default export is a Pi extension factory registering the command through `pi.registerCommand`. Verified end-to-end through the real installed Pi CLI (see tests below).
- Storage/artifact packages expose real accessibility probes only (M0 boundary); no session data, no second Pi store.
- `core` contains the doctor domain only (pure, injected probes, no fs/process/network/Pi imports).

## API decisions (Pi 0.87.0, verified against installed package)

- Extension loading via public mechanisms only: default-export factory receiving `ExtensionAPI`; loaded through `pi -e <path>` in tests. No Pi fork, patch, or internal import.
- Command registration: `pi.registerCommand(name, { description, handler })`; handler context fields used: `mode`, `cwd`, `ctx.ui.notify(message, tone)` for TUI mode.
- Print mode output: the adapter writes the report through an injectable output stream (default `process.stdout`).
- Observed Pi CLI behavior (documented for future tests): when spawned with piped stdio, `pi -p` routes print-mode output to **stderr**; when attached to a terminal it uses stdout. Tests accept either stream.
- `VERSION` export of `@earendil-works/pi-coding-agent` used for best-effort host version reporting inside the extension.

## Environment evidence

- `pi --version` → `0.87.0`
- Node under test: `v22.18.0` (Linux/WSL). `node:sqlite` functional but emits `ExperimentalWarning` on 22.x.
- Test-runner note: `node --test <dir>` (directory argument) is not supported on Node 22; package test scripts use the glob `dist/**/*.test.js` which works on both Node 22 and 24.

## Tests run (real commands, real results)

`corepack pnpm check` = `tsc -b` (root, project references) + `pnpm -r test`:

| Package | Suite | Result |
|---|---|---|
| core | boundary / runDoctor / formatting / version | 14 pass |
| artifact-fs | probeArtifactRoot | 2 pass |
| storage-sqlite | probeSqliteStorage | 3 pass |
| cli | relay cli (usage, doctor, json, exit codes, secret non-leak) | 5 pass |
| adapter-pi | public API unit + **real Pi CLI integration** (`pi -e ... -p "/relay:doctor"` in a temp cwd, exit 0, secret env var absent from output) | 5 pass |

Total: 29 pass, 0 fail. Boundary test enforces that only `adapter-pi` may import `@earendil-works/pi-coding-agent`.

Manual gate checks:

- `node packages/cli/dist/src/cli.js doctor` → `summary: ok`, exit 0 (repo root).
- `pi -p "/relay:doctor" -e packages/adapter-pi/dist/src/index.js` → full report, exit 0 (temp cwd).

## Fixes made while closing the gate (this session)

1. `exactOptionalPropertyTypes` violation in the adapter test mock (`type?: string` vs `string | undefined`).
2. Package test scripts: `node --test dist` → `node --test "dist/**/*.test.js"` (Node 22 directory-arg incompatibility).
3. Replaced `mock.method(process.stdout, "write", ...)` capture (raced with the node:test TAP reporter) with an injected output stream on the extension factory.
4. Integration test now resolves the Pi CLI bundle from `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` and spawns it via `process.execPath` with an args array — no PATH/shell/quoting dependence, cross-platform.

## Failures / limitations

- Node 24 leg of the matrix (T24) not yet executed in this environment (only Node 22.18 available here); must run before v0.1 release.
- `node:sqlite` is experimental on Node 22.x (warning only; probes pass).
- Doctor probes create `.relay/` lazily in the target cwd; no cleanup is performed by design (they are durable locations).

## Files changed (relative to `de8afc1`)

- Created: `.gitignore`, `pnpm-workspace.yaml` content, `packages/core/**`, `packages/storage-sqlite/**`, `packages/artifact-fs/**`, `packages/adapter-pi/**`, `packages/cli/**`, `pnpm-lock.yaml`, `prompts/IMPLEMENT_M0_FOUNDATION.md`, this report.
- Modified: `AGENTS.md` (persistent-state invariants), `README.md` (portable local-workspace commands), `package.json` (scripts/devDependencies), `tsconfig.json` (project references), `scripts/start-relay-m0.ps1` (repo-root derived from script location), `prompts/AGENTDOCK_PI_GLM53.md`.

## Next milestone blockers

None. M1 (External Effect Guard) can start: `tasks/M1_EFFECT_GUARD.md` defines the effect state machine, mock HTTP counter provider, and crash-injection matrix.
