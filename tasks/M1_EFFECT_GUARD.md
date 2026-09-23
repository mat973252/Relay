# M1 Task — External Effect Guard

## Mission

Prove Relay can prevent silent duplicate unsafe outside-world mutations after Pi/runtime crash.

## Required API shape

The exact syntax may evolve, but the semantic contract must resemble:

```ts
await relay.effect({
  key,
  kind,
  request,
  replay: "never",
  execute,
  reconcile,
});
```

## Required persisted data

At minimum:
- effect id
- semantic key
- kind
- request hash
- status
- provider/remote reference where available
- timestamps
- result artifact reference if confirmed

## State model

- PREPARED
- SUBMITTED
- CONFIRMED
- FAILED
- UNKNOWN

## Mock provider

Build a local HTTP fixture:

- `POST /increment` increments a durable counter
- optional idempotency key mode
- `GET /effects/:key` allows reconciliation

## Crash tests

Inject termination:
1. before PREPARED commit
2. after PREPARED
3. immediately before POST
4. after request leaves client
5. after remote counter increments but before Relay receives response
6. after response, before CONFIRMED commit
7. after CONFIRMED commit

## Gate

Relay must never silently produce counter=2 for one logical non-replayable effect.

When remote truth is unknowable, persist UNKNOWN and stop automatic replay.
