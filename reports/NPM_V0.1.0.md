# npm v0.1.0 distribution

2026-09-26: owner authorized npm publication after the GitHub source release.
The authenticated npm account is mat973252. Seven packages use that account's
scope: relay-core, relay-epistemic, relay-storage-sqlite, relay-artifact-fs,
relay-cli, relay-mcp and relay-adapter-pi, all version 0.1.0.

Public names change only packaging. Internal dependency keys remain @relay/*
through pnpm workspace aliases, which pack into npm aliases pointing at the
owner's packages. Runtime source is unchanged. One crash fixture uses a relative
self-import after the package rename. The Pi peer range is limited to 0.87.x;
runtime packages require Node 22.13+ (SQLite unflagged), with Node 24 recommended.

Package files are restricted to compiled runtime JS/types, README and MIT
LICENSE. Tests, credentials, workspace paths and source maps are not shipped.
The root workspace remains private. Reproduce packing after a clean build:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm --filter '@mat973252/relay-*' pack --pack-destination /absolute/tarball-directory
```

Local verification: clean typecheck; Windows full suite 202 passed, 2 existing
permission-related skips; exact tarball manifests contain no workspace:
dependency specifiers. Seven tarballs installed by npm in an isolated consumer
using a loopback registry for the unpublished scope and the public registry for
external dependencies. CLI help and a real MCP session exercised initialize,
tools/list, 202 -> unknown, unresolved discovery, repeat submit, reconciliation
to confirmed and CLI history; exactly one POST reached the local provider.

`node scripts/verify-npm-consumer.mjs /absolute/consumer-directory` repeats that
runtime check against an npm installation. Registry publication and a fresh
public-registry consumer are verified separately after upload; local tarball
success alone does not mean packages are published.

See [usage](../docs/NPM-USAGE.md). All v0.1.0 effect/provider and capsule data
boundaries still apply. The earlier GitHub source release remains immutable;
its source-only statement describes that earlier release snapshot.
