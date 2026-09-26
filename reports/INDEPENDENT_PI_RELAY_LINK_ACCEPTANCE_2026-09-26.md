# Independent acceptance: isolated Pi → Relay key linkage

Date: 2026-09-26. Documentation/evidence stage only.

## Accepted scope

Relay [PR #4](https://github.com/mat973252/Relay/pull/4), final head `b09869190fcdd39c2711160eecadb3c0f656a95d`, was independently reviewed and merged as `6d7a2eb`.
Only three files under `reports/pi-relay-link-probe-2026-09-26/` changed. No product code or safety gate changed.

The probe uses an actual Pi 0.87.0 AgentSession, persisted session JSONL, a deterministic local fake model, a custom-tool bridge forwarding arguments to the unmodified Relay MCP server, and a provider bound to 127.0.0.1. It is not a hand-authored transcript or a native Pi MCP client: this Pi version has no built-in MCP client.

## Independent replay

Codex used a clean WSL Ubuntu worktree at the final PR head, Node `v24.4.1`, pnpm `10.33.0`:

```sh
pnpm install --frozen-lockfile
pnpm -r exec tsc -b
pnpm typecheck
RELAY_SOURCE_SHA=$(git rev-parse HEAD) node reports/pi-relay-link-probe-2026-09-26/probe/probe.mjs <isolated-output-directory>
```

All commands passed. Install warned about not-yet-built CLI bins and ignored dependency build scripts; neither prevented the replay. The final documented recursive build sequence was verified from this clean checkout.
An earlier replay tried CLI-first compilation, which failed on an unbuilt `@relay/epistemic` output; root compilation thereafter succeeded. That earlier run was not evidence that root compilation alone always works on a fresh checkout.

The replay's generated evidence SHA-256 was `5ad04e07ecb1f2ca3e1822090863dacefe8dd4f873235e2c67aa9aaa81badb6d`.
Codex independently joined persisted tool calls to journal rows/events by the requested exact argument values, rather than trusting the probe's boolean summaries:

- Four tool calls matched four effect keys and IDs; each effect had three committed transitions.
- Success and both discrimination-control calls ended CONFIRMED; the commit-then-503 call ended UNKNOWN with no settlement timestamp.
- The loopback provider counter ended at 4. Its observed commits are evidence of this fake provider only.
- CLI history exited successfully for all three scenarios. Session tool-call IDs connected each recorded tool result to its call.
- The probe file is unchanged in the final correction; its SHA-256 remains `88b3f4d3fb97e90150b9092a04692a1f300f9c7df7236e8f12a11d4674f814b7`.

No Windows probe replay or real provider/model-service invocation was performed for this documentation stage. Existing Relay product acceptance reports remain separate.

## Limits and next boundary

Accepted: a precise **key match** from this observed Pi custom-tool call to Relay effect evidence. It is not proof of exclusive ownership or general causality: operation IDs can be reused across calls/sessions, another bridge can rewrite arguments, and journal records carry no Pi session/tool-call ID. The reverse journal → session association is unavailable.

Pi's normalized Run/tool events may be inspected with their existing importer semantics, while Relay effect evidence must remain separately sourced. UNKNOWN stays UNKNOWN even if Pi records a successful protocol/tool return. Missing Run/Step/Recovery facts must stay unknown/unrecorded; no effect transitions may be renamed into fabricated AgentEvents.

The Relay overall safety gate remains **CLOSED**. Real provider completion/reconcile contracts and non-protocol local writers are still outside this acceptance. No Step6/7, production trace, real external effect, or AgentLens M8 acceptance is claimed.
