# M3 Result — Capability Contract + Doctor

Status: **PASS** (gate satisfied on the audited environment)

## Implemented behavior

- Pure capability model in `@relay/core` (`capabilities.ts`): `CapabilitySpec` (id/label/required/check), states `AVAILABLE | DEGRADED | MISSING | DENIED`, decision `READY | DEGRADED | BLOCKED`, `evaluateCapabilities()` over injected probes (deterministic, duplicate-id rejection, missing-probe surfaced as MISSING), `activationExitCode()`.
- `relay.capabilities.yaml` (schema `relay.capabilities/1`) parsed in `@relay/cli` (`capabilities.ts`, `yaml` package — the only YAML in Relay, human-authored config only). Check kinds: `command-on-path` (with optional version pattern), `node-module`, `http` (with `secretHeaders`), `env-ref`, `custom` (programmatic only).
- `relay doctor` now evaluates `./relay.capabilities.yaml` (or `--capabilities PATH`) when present: renders a capability section, an `activation:` decision line, and combines probe + capability severity into the exit code (`0 READY | 1 DEGRADED | 2 BLOCKED`). `--json` carries the full evaluation under `capabilities`.
- Secret isolation mechanized: `packages/cli/src/env.ts` is the single sanctioned `process.env` reader (enforced by the updated workspace boundary test); secret references are env var NAMES in YAML; http probes use values in-flight only. Secret values never appear in any result, output, or serialized evaluation (asserted by tests).

## API decisions

- Required capability must be **AVAILABLE** to activate (architecture invariant): required MISSING/DENIED/DEGRADED all BLOCK. Optional non-AVAILABLE degrades only.
- DENIED (as opposed to MISSING) means "referenced but not granted" — e.g. secret reference unset, HTTP 401/403.
- Capability config is data; probes are injected. The Pi adapter can reuse the same evaluation with programmatic `custom` probes without YAML.

## Tests run (real commands, real results)

`corepack pnpm check` — totals **84 pass, 0 fail** (core 39, storage-sqlite 15, artifact-fs 11, cli 14, adapter-pi 5).

- core/capabilities.test.ts: full decision matrix (T02 READY, T03 optional-missing DEGRADED runnable, T04 required-missing BLOCKED, required DEGRADED blocks, optional DEGRADED degrades, missing probe config error, duplicate id rejection).
- cli/capabilities.test.ts: YAML parse + validation (bad schema/check rejected); real `relay doctor` runs: optional missing → exit 1 with `activation: DEGRADED`; required missing → exit 2 `BLOCKED`; required secret present → exit 0 READY with value absent from output (T14); required secret unset → exit 2 `[DENIED/required]`; http probe sends the secret header in-flight (server-asserted) while the evaluation JSON provably excludes the value; invalid file → exit 2.
- Boundary test updated: `process.env` allowed only in `packages/cli/src/env.ts` (the file must actually read it — guards against a vacuous allowance).

## Files changed

- `packages/core/src/capabilities.ts` (new, exported).
- `packages/cli/src/env.ts` (new, sanctioned env reader), `packages/cli/src/capabilities.ts` (new), `packages/cli/src/cli.ts` (doctor wiring), `packages/cli/package.json` (+`yaml`, workspace deps pinned).
- Tests: `packages/core/test/capabilities.test.ts`, `packages/cli/test/capabilities.test.ts`, boundary test update.
- `pnpm-lock.yaml` regenerated.

## Gate check

- "Required missing capability blocks activation" — **PASS** (unit + real CLI exit codes).
- "Optional missing capability degrades only" — **PASS**.
- "Secret value grep over project output returns zero matches" — **PASS** (T14 tests; capsule-wide grep comes with M4 export and re-runs there).

## Next milestone blockers

None. M4 (Capsule Export/Import: manifest, atomic export, file hashes, secret exclusion, import validation, migration evidence, activation boundary) can start per `docs/ROADMAP.md`.
