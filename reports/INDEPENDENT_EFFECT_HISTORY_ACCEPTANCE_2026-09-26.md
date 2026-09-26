# Independent acceptance: effect transition evidence

Date: 2026-09-26 (Asia/Shanghai). Scope: [Relay PR #3](https://github.com/mat973252/Relay/pull/3), final Devin head `8611ac584dfe7f9a7ca192ff5cdba15bfce73dd0`, merged into `main` as `21700c84692cdbc5704bb09c1ed751ad4c4852f1`.

## Decision

Accepted this **bounded effect-evidence stage**. The new append-only events record committed Relay effect transitions and explicit reconcile observations. The latest `relay_effects` row remains the execution authority. This acceptance does **not** clear Relay's overall safety gate, authorize Step 6/7 or real external effects, or complete AgentLens M8.

## Independent review

- The initial PR had a split read in `listHistory()` that could pair a latest row with events from different SQLite snapshots. Devin fixed it in the same PR with a deferred read transaction and a deterministic interleaved-writer regression for filtered and unfiltered reads.
- A second review found that event `reason` and `remoteRef` would have retained provider-controlled text in an append-only table and exported it in `effect-events.json`. Devin removed those free-form fields from the event type, schema, CLI history view, and capsule evidence, while retaining the pre-existing latest-state row behavior. The event validator rejects extra fields on capsule import. Fake-provider and CLI/capsule tests cover a secret-like marker. The older, unmerged PR schema is migrated by dropping those columns without inventing historical events.
- Row mutation and event insertion share a SQLite transaction; rejected transitions append nothing. Old rows without events remain labeled `unavailable` or `partial`. Capsule import checks event-chain consistency against latest-state rows, but capsule contents do not prove that an external provider committed an effect.

## Independent execution evidence

All tests used disposable workspaces and loopback fake providers. No real external provider was called.

| Environment | Result |
| --- | --- |
| Native Windows, Node 24.13.0, pnpm 10.33.0 | Fresh clone and frozen install passed. Root `typecheck` initially hit the pre-existing adapter-pi to CLI project-reference ordering issue; building CLI first, then rerunning root `typecheck`, passed. Targeted history, crash matrix, MCP history, and capsule history tests passed **27/27**. |
| WSL Ubuntu, Node 22.18.0, pnpm 10.33.0 | Frozen install, typecheck after known project-reference bootstrap, full workspace tests **181/181**, and crash demo passed. |
| WSL Ubuntu, Node 24.4.1, pnpm 10.33.0 | Frozen install, typecheck, full workspace tests **181/181**, and crash demo passed. |

The Windows workspace-wide suite remains limited by a pre-existing path-separator assertion in the core boundary test. The crash demo's POSIX `SIGKILL` assertion was verified under WSL, not native Windows. This repository has no hosted CI checks for PR #3.

## Remaining boundaries

- `relay_effects.reason`, `result_json`, and `remote_ref` retain their prior free-form latest-state behavior and are still included in `effects.json`. The new event stream does not copy `reason` or `remoteRef`; this stage is not a general secret-scrubbing change. Existing backups or SQLite copies made from an earlier PR revision are outside the migration's deletion guarantee.
- Stable Pi session/tool association and complete Run/Step/Recovery events were not demonstrated. Do not reconstruct them from the effect stream or present isolated samples as production traces.
- Real provider completion/reconcile contracts and non-protocol local writers remain outside the tested safety envelope. The overall Relay safety gate stays closed. AgentLens M8 remains unaccepted.
