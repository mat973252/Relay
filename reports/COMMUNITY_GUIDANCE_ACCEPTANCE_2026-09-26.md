# Community guidance acceptance — 2026-09-26

Scope: `relay effects --explain [--key KEY] [--storage PATH]`. Research and alternatives are recorded in [the research note](../docs/community-research-2026-09-26.md).

## Verified locally

- Regression test first failed with unknown option `--explain`; implementation then passed.
- WSL Node 22.18.0, frozen pnpm install, typecheck and full recursive workspace tests completed, including MCP and Pi deferred migration/crash/extension integration. This is local loopback/synthetic integration, not production effects.
- Final CLI suite: 49 tests passed. After extending missing-key, conflicting-flags and corrupt-file assertions, typecheck and both focused guidance tests passed again.
- Existing journal bytes and mtime unchanged; no missing database created; arbitrary provider payload fields omitted. SQLite may create/use WAL/SHM coordination files during a readOnly open, so directory immutability is not promised.
- UNKNOWN/SUBMITTED do not authorize re-submission. Generic, mismatched and empty MCP identities produce no candidate tool arguments; preserved operation IDs may contain colons. PREPARED/FAILED do not authorize retries. No provider requests or engine changes.
- Source review retained recorded-state and ownership boundaries. Malformed event warnings explicitly include other keys in the sampled journal. Exit 0 means explanation succeeded, not business success.

Windows dependencies contained WSL symlinks, so this package was verified in WSL rather than claiming a native Windows run. Published npm v0.1.0 was not changed. No merge or release was performed. Real adoption and incident reduction remain unmeasured.
