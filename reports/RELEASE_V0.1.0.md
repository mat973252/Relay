# Relay v0.1.0

First source release, prepared on 2026-09-26. The owner authorized publication
and selected MIT. Workspace packages remain private; this is a GitHub Release,
not an npm publication. Install from the tagged source using the README.

## Included

- Durable external-effect journal, stable operation IDs and read-only reconciliation.
- Local stdio MCP server with one live owner per trusted workspace.
- Pi reference adapter and Claude Code/Codex host templates.
- Artifact lineage, capability checks, controlled capsule migration and status export.
- Model-free crash demo and durable synthetic order-export business sandbox.

## Validation

The release CI matrix runs frozen installation, typecheck, all tests, the
seven-assertion crash demo and host-template validation on Windows/Linux with
Node 22/24. Publication is gated on successful hosted runs; the release notes
link the actual completed run rather than treating this configuration as proof.
Host-template checks are structural and do not call authenticated coding agents.

Prior local evidence: Windows Node 24 passed 202 of 204 tests with two existing
permission-dependent skips. Linux Node 22/24 passed the prior 199-test baseline
and the five added business tests separately. See
[Windows evidence](WINDOWS_PROOF_ACCEPTANCE_2026-09-26.md) and
[business evidence](BUSINESS_SANDBOX_ACCEPTANCE_2026-09-26.md).

The Windows chmod/symlink permission skips are documented platform limitations;
the corresponding paths must pass on Linux. They do not establish Windows
permission-denial behavior. The source archive must also build in a fresh
consumer and reproduce the crash demo before publication.

## Boundaries

Protection applies only to configured Relay tool actions. Stable domain IDs and
a reliable provider completion/reconciliation contract are required. UNKNOWN
does not authorize a blind retry. Bypassing Relay or inventing a new operation
ID for an old intent is outside the guarantee. The synthetic business and actual
AISIX/GLM calls prove that tested contract, not arbitrary production providers
or universal model behavior. DeepSeek's empty tool-use response remains an
unisolated integration issue; AgentLens does not automatically associate
reconcile-only sessions.

Relay does not automatically read environment values or unselected workspace
files into capsules. Journal payloads, artifact bytes, explicitly supplied
adapter files and capability configuration are caller-owned export data and
must be reviewed for secrets. No blanket secret-free guarantee is made for
opaque bytes. Controlled single-writer migration is supported; cross-host
failover, arbitrary local database writers and power-loss durability are not
validated by this release.

Earlier reports and task stop points remain dated historical evidence. This
release authorization supersedes their publication hold, not their technical
limitations. Actual external adoption remains unmeasured.
