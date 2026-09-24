# Next iteration: enter coding agents through a shared effect boundary

Status: proposed after review on 2026-09-24. Do not publish or push in this iteration.

## Objective

Make a developer who has never seen this repository reproduce one precise claim:
an agent process dies after an external HTTP action commits, then restarts;
Relay does not silently submit that action again. An ambiguous result remains
`UNKNOWN` until a read-only reconciliation confirms it.

The product form is one host-independent effect engine exposed through a local
stdio MCP server, plus thin host packages. Pi remains the first native adapter;
the next two entry points are Claude Code and Codex. Artifact lineage, capsule
migration, and Stage B remain available but are not part of the first-run path.

## Integration boundary

- The MCP server executes a small, explicitly configured class of external
  actions through Relay's journal and reconciliation contract. It returns
  `CONFIRMED`, `UNKNOWN`, or a concrete failure with a stable effect key.
- A host package contributes MCP configuration, a short skill/command, and
  optional session/known-tool hooks. Host packages do not own durable state or
  implement another effect journal.
- Hooks can point agents to Relay or block a known bypass path, but pre/post
  events alone cannot prove whether a remote action committed. Do not claim
  protection for arbitrary shell commands, built-in tools, or other MCP servers.
- The guarantee applies only when the action is executed through Relay. A
  stronger enforced mode would also keep the destination credential available
  only to the Relay process and deny direct use where the host permits it.
  That mode requires its own bypass and fail-closed tests before being claimed.
- v0.1's effect runner assumes one active writer per workspace. Two coding
  agents may each spawn a copy of the stdio server. A second live server must
  fail closed before offering effect tools, or the implementation must prove
  serialized ownership. A unique database key alone is insufficient: an
  in-flight `PREPARED` record is also the state used for crash continuation.
- The semantic effect key must survive a new agent session. Do not let the
  model invent a fresh key on every retry, and do not use only a request hash:
  two intentional identical actions must remain distinguishable. Provide a
  durable prepare/commit identity or a domain-specific stable operation ID,
  plus a way to list unresolved operations before submitting a new one.

## Starting state and review findings

- HEAD at review: `20abe69`; import/capability coherence Step 1 is committed.
- Local uncommitted review edits in `packages/cli/src/capsule.ts`,
  `packages/cli/test/capsule.test.ts`, and `packages/core/src/capsule.ts` fix
  overwrite protection, cover interrupted-import retry, and correct a misleading
  secret claim. Preserve and review these edits; do not reset them.
- Windows / Node 24: `corepack pnpm check` passed with 116 tests passed,
  1 skipped (`chmod` cannot reliably deny writes on Windows). The committed
  Step 1 report records 115 passing tests on WSL / Node 22 before these edits.
- No LICENSE, public CI, installable release, independent quickstart, or
  external-user adoption has been verified. Do not report any of these as done.
- Capsule export accepts caller-supplied adapter files and arbitrary artifact
  bytes. Current tests only show that selected fixture secrets were excluded;
  they cannot prove a blanket “no secrets in capsules” guarantee.

## This iteration: work order

1. **Close the review baseline.** Inspect the three uncommitted files and the
   intended overwrite semantics. Run `corepack pnpm check` and
   `git diff --check`. Keep the one Windows permission skip visible. Commit
   only the reviewed fix once the checks pass; record the exact counts and
   platforms in a short result report.
2. **Add one host-independent executable demo.** Use `@relay/core` and
   `@relay/storage-sqlite` directly, with a local HTTP counter and an
   injectable process-death point after server commit. Run the same semantic
   effect key after restart. Assert counter `=== 1`, the journal transitions
   through `SUBMITTED`/`UNKNOWN` as applicable, and reconciliation performs
   only a read before `CONFIRMED`. The script must run without Pi, a model
   account, cloud credentials, or Docker. Keep it small enough to understand
   in one sitting; link to it from the README.
3. **Make the result legible.** Put the failure, restart, journal status,
   reconciliation, and remote counter in the demo output. Document the exact
   run command and expected output. State the real guarantee: no silent retry
   of an ambiguous unsafe action; downstream idempotency or a reliable
   reconciliation query is needed for stronger guarantees.
4. **Implement the smallest MCP vertical slice.** Expose the demo's one
   configured HTTP action and read-only reconciliation via a local stdio MCP
   server using the existing Relay engine. Keep destination and credentials
   out of model-supplied arguments. Test an MCP client call, a crash after
   remote commit, restart, and counter `=== 1`. Do not create a generic
   arbitrary-URL proxy or a second journal. Test two server processes against
   one workspace: the second must not execute while the first owns it, and
   ownership must be recoverable after process death on Windows and Linux.
   Test a fresh agent session discovering the existing operation ID and
   reconciling it without creating a replacement ID.
5. **Package two thin host entries.** Prepare local Claude Code and Codex
   plugin packages that register the same MCP server and explain the safe
   action path. Test installation in clean temporary profiles and, where a
   real local host session is available, make one actual tool call through
   each host. Document exact coverage and bypasses. Pi stays as the existing
   native reference; Cursor/Gemini/OpenCode wait until this slice works.

Stop for review after step 5. The following are release-readiness work for a
subsequent iteration, not permission to publish:

6. **Prepare public distribution evidence.** Add a CI matrix for Node 22 and
   24 on Windows and Linux, including typecheck, tests, MCP demo, and plugin
   package validation. Verify local archives in clean temporary consumers.
   Prepare a LICENSE choice for the owner and record the selected SPDX
   identifier only after the owner chooses it. Do not publish packages,
   create a remote, or push.
7. **Resolve the capsule security claim before any public release.** Either
   narrow the promise to “Relay does not automatically read env values or
   unselected workspace files” and clearly mark caller-owned artifact/adapter
   bytes as exportable, or implement a reviewable explicit selection policy.
   Never claim arbitrary opaque bytes are proven secret-free. Check that the
   README and result report use the same wording.

## Acceptance gate for this iteration

- A clean consumer can follow a short README section and reproduce a remote
  counter of exactly one through crash, restart, and read-only reconciliation.
- The demo has an automated assertion for the dangerous crash window, not
  just screenshots or narrated output.
- The same local MCP server is callable from clean Claude Code and Codex
  plugin installations. A model's mere awareness of a tool does not count as
  an executed, protected effect; record actual calls or the exact blocker.
- Tests show that an unprotected direct action is outside the guarantee, and
  no README or plugin text implies universal interception.
- A concurrent second host process cannot execute an effect against the same
  workspace while the first is active; after killing the first, restart
  recovery preserves the counter and journal outcome.
- The operation identity is durable across a new session, and the MCP contract
  makes unresolved operations visible before a repeated intent is submitted.
- Local tests report exact pass/fail/skip counts and platform versions. Node
  22/24 hosted CI remains a separate release gate until it has actually run.
- The two host entries load in clean temporary profiles. Record any failure
  rather than calling an untested archive or configuration ready.
- The result report separates implementation, local tests, hosted CI status,
  release readiness, and external adoption. Stars or test counts are not
  treated as adoption.

## Stop point

Stop after step 5 with a reviewable local diff, test output, host-entry
install evidence, and result report. Do not start steps 6–7 before review.
Ask the owner to decide the license and authorize any remote creation, push,
package publication, or public announcement. Stage B integration,
failover/fencing, a second adapter, and a web UI are outside this iteration.
