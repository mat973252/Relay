# Community iteration: read-only effect guidance

2026-09-26. Observed need: an ambiguous external operation cannot safely be retried just because its response was lost. Sources: [Temporal user report](https://community.temporal.io/t/is-retry-policy-applicable-to-platform-temporal-error/18482), [MCP proposal](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1597).

Scope: `relay effects --explain [--key KEY]` reads the existing journal without migrations, explains recorded states and points to configured reconciliation. Existing JSON/history output stays unchanged. No engine change, automatic retry, provider request or publication.

Acceptance: explicit unknown guidance, preserve operation identity, no guessed MCP mapping, no payload disclosure, missing/corrupt database errors, byte/mtime stability; full typecheck and workspace tests. Independent user adoption remains unmeasured.

Completed locally; results and SQLite sidecar boundary: [acceptance report](../reports/COMMUNITY_GUIDANCE_ACCEPTANCE_2026-09-26.md). Not released.
