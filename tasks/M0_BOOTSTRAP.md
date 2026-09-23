# M0 Task — Pi-native Bootstrap

## Mission

Create the minimal Relay monorepo and integrate with the **currently installed Pi API** without forking Pi.

## Before coding

Run and record:

```powershell
pi --version
pi --list-models "glm-5.3"
```

Inspect current Pi docs/source for:
- extension/package entry point
- lifecycle hooks
- session metadata/custom entries
- tool hooks
- AgentHarness public interfaces
- resume/suspended/deferred APIs available in the installed/current version

Do not implement against guessed API names.

## Build

Create:
- `packages/core`
- `packages/adapter-pi`
- `packages/storage-sqlite`
- `packages/artifact-fs`
- `packages/cli`

Implement only enough for:

```text
relay doctor
```

and a Pi-visible command such as:

```text
/relay:doctor
```

The first command may initially report only:
- Relay version
- Pi compatibility
- working directory
- storage accessibility
- artifact directory accessibility

## Tests first

Write tests proving:
- core has no Pi dependency
- adapter is the only package allowed to import Pi packages
- doctor returns deterministic status
- no secret environment value is printed

## Exit gate

- typecheck green
- tests green
- Pi extension loads
- `/relay:doctor` works
- `reports/M0_RESULT.md` written
