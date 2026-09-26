# Next stage: isolated Pi to Relay effect linkage probe

Date: 2026-09-26. This is one bounded Devin investigation stage with a hard ceiling of **10 ACU**. Start from current Relay `main`. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `reports/INDEPENDENT_EFFECT_HISTORY_ACCEPTANCE_2026-09-26.md`, and AgentLens [`docs/m8-relay-dogfood.md`](https://github.com/mat973252/agentlens/blob/main/docs/m8-relay-dogfood.md) first. Use the public Pi [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) and [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) as source contracts, but verify actual behavior rather than inferring it from documentation.

## Question to answer

Can an **actual isolated Pi tool invocation** of Relay's MCP action be linked to an actually committed Relay effect event by a stable, non-secret key, without guessing from timestamps, directory paths, or model prose? The candidate is the Pi session's tool-call arguments `actionId` and `operationId`, matched to Relay's journal key `${actionId}:${operationId}`. This is a hypothesis, not an accepted association.

## Scope and evidence

1. Use a disposable session, database, and loopback fake provider only. If a model is needed, use a local deterministic fake model/provider; do not use a real model service, user Pi sessions, user credentials, production journal, or real external effect. Never print or persist secrets.
2. Inspect public Pi SDK/session APIs for session ID, tool-call ID, tool name, arguments, and tool result persistence. Build the smallest one-off probe outside product packages. Trigger the Relay MCP action through Pi's actual tool path if feasible, with a preselected non-secret `actionId` and `operationId`.
3. Save a sanitized, replayable evidence bundle under `reports/` (or explain why that is unsafe). Include the Pi session entry ID/tool-call ID, exact tool name and non-secret `actionId`/`operationId`, Relay source SHA, effect key/ID, committed event sequence and state, file hashes, Node/Pi versions, commands, and provider counter. Prove the association by exact values, not proximity. Record whether the tool result and effect journal agree after success and after pending/unknown or failed outcome.
4. If Pi's normal MCP path cannot run against a local fake model without credentials or if session persistence omits the needed arguments, stop and write the precise limitation with source links. Do not manufacture a transcript, backfill events, or call it a verified link. Also record that a linked effect does not prove complete Run/Step/Recovery coverage or real-provider completion.

## Boundaries and stop

No Relay or AgentLens product code, npm publication, Step 6/7, real provider, public user session, or safety-gate change. Use branch `devin/pi-relay-link-probe`; submit a documentation/evidence-only PR against `main`, then stop without merging. Return exact commands, hashes, observed data, and limitations. If the evidence cannot be gathered within 10 ACU, stop with a blocker report rather than a claimed success.
