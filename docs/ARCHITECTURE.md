# Relay Architecture v0.1

## Position

```text
                Pi AgentHarness
    Reason ─ Tool ─ Suspend ─ Resume
                     |
              public hooks / SDK
                     |
                  Relay
         ┌───────────┼────────────┐
         |           |            |
      Effects     Artifacts    Environment
         |           |            |
     what happened  what exists   can it run?
         └───────────┼────────────┘
                     |
                  Capsule
                     |
              controlled migration
                     |
                  Pi resume
```

Pi remains the authority for agent execution semantics.

## Modules

### 1. `@relay/core`
Pure domain contracts and state machines:
- `EffectRecord`
- `EffectStatus`
- `Artifact`
- `ArtifactLineage`
- `Capability`
- `DoctorResult`
- `CapsuleManifest`
- integrity helpers

No Pi imports in this package.

### 2. `@relay/storage-sqlite`
Persistence for Relay-owned state:
- effect journal
- migration records
- artifact metadata index if needed

SQLite is NOT a second Pi session store.

### 3. `@relay/artifact-fs`
Content-addressed local artifact store:
- `sha256`
- atomic write
- metadata
- parent references

### 4. `@relay/adapter-pi`
The only Pi-specific module:
- lifecycle hooks
- tool/effect wrapping
- session metadata references
- suspended/deferred state discovery via Pi APIs
- export/import glue

It must use public Pi APIs and avoid monkey patches.

### 5. `@relay/cli`
Commands:
- `relay doctor`
- `relay effects`
- `relay effects --history` (read-only latest-state snapshot + observed transition events + coverage)
- `relay artifacts`
- `relay lineage <artifact>`
- `relay export`
- `relay import <capsule>`
- `relay inspect`

## Effect state machine

```text
PREPARED
   |
   v
SUBMITTED ---- crash/uncertainty ----> UNKNOWN
   |                                  |
   v                                  v
CONFIRMED                          RECONCILE
   |                           /       |       \
   v                         FOUND  NOT_FOUND  UNCERTAIN
terminal                      |         |          |
                              v         v          v
                         CONFIRMED   retry*     UNKNOWN
```

`retry*` is permitted only when the operation is provably safe/idempotent under the provider contract.

### Effect evidence

`relay_effects` holds one latest-state row per key and is the only execution
authority. `relay_effect_events` is an append-only record of transitions that
were actually committed (`from -> to`, cause `prepare|submit|execute|reconcile|unknown`,
timestamp) and nothing else — free-form `reason`/`remoteRef` stay on the
latest-state row and are never copied into events, `relay effects --history`
event lines, or `effect-events.json`. Events are written in the same SQLite transaction as the
row update, so a crash can never leave a row without its event or an event
without its row. Repeated uncertain reconciles append `UNKNOWN -> UNKNOWN`
observations. Rejected transitions and deduplicated re-entries append nothing.
Legacy rows are never backfilled; their history is labeled `unavailable`
(`partial` once they transition again). Capsules carry `effect-events.json` only
when events exist; import validates it against `effects.json` and rejects any
contradiction rather than trusting the stream.

## Artifact identity

Artifact content uses SHA-256 identity:

```text
artifact://sha256/<digest>
```

Metadata:
- producer type/id
- Pi session/run/tool-call references where available
- parent artifact IDs
- media type
- byte size
- createdAt

## Capability states

- AVAILABLE
- DEGRADED
- MISSING
- DENIED

Required capabilities must be AVAILABLE before activation.

## Capsule definition

A capsule is an export format, not a runtime.

It contains:
- Relay manifest
- explicitly selected Pi durable/session material required for resume
- Relay effect journal
- artifact index/content
- workspace snapshot or workspace reference policy
- capability requirements
- migration evidence

Relay does not automatically read environment values or unselected workspace
files into capsules. Exported journal payloads, artifact content, explicitly
supplied adapter material and capability configuration are caller-owned data.
Callers must review those inputs for secrets before export; arbitrary opaque
bytes are not proven secret-free.

## v0.1 migration guarantee

Controlled single-writer migration only:

```text
source quiesce
→ export
→ source deactivate
→ target import
→ doctor
→ target activate/resume
```

Automatic distributed failover, leases, fencing and split-brain protection are v0.2+.
