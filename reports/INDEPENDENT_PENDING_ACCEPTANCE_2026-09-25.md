# Independent acceptance: pending MCP outcomes

Date: 2026-09-25. Reviewed Devin branch head `98bf76b2be2d55a2cf1d4afae2a1399fcbd2a71e`; merged as PR #1, main `db03b617a2bee848e439fe2da9c7a2344b40eabf`.

## Result

The two pending-outcome defects in `tasks/NEXT_ITERATION_PENDING_OUTCOMES.md` are repaired and independently accepted. A POST returning HTTP 202 with `status: pending` stays UNKNOWN; a prior ambiguous operation reconciled with HTTP 200 `status: pending` stays UNKNOWN. Neither path repeats the submit. Unknown or malformed statuses also stay unresolved. Configured proof of non-execution can settle FAILED, and proven synchronous completion can settle CONFIRMED. The configuration rejects `pending` as terminal proof and rejects overlapping executed/non-executed status lists, including overlap with the default `complete` status. Changing an explicit status contract changes the request identity, so an existing operation ID cannot be reinterpreted under new status semantics.

The review used disposable workspaces and loopback fake providers only. No real external effect was run.

## Independent checks

- Windows Node 24.13: fresh frozen pnpm install; the pending-outcomes test file passed 14/14. `git diff --check` passed. Initial clean typecheck needed the pre-existing CLI-first build workaround before passing.
- WSL Ubuntu Node 22.18 and Node 24.4: typecheck passed; full suite passed 158/158 on each version; crash demo passed on each with one remote execution and reconciliation after restart.
- GitHub reported no CI checks for PR #1. The test results above came from independent local runs, not GitHub Actions.

## Remaining safety limits

- Windows Node 24.13 full MCP suite did not pass: an existing two-process lock race test failed with `EPERM` while renaming a temporary claimant file. The same test reproduced the same failure on a separate checkout of the unchanged base commit. The pending-outcome repair did not change the lock module. This remains a separate safety and portability investigation.
- A clean Windows typecheck still has a pre-existing package build-order issue involving `adapter-pi` and `cli`.
- This acceptance covers the pending-outcome repair only. It does not clear Relay's overall safety review, authorize Step 6/7, or prove production provider behavior. AgentLens M8 still lacks a complete, trustworthy Relay Run/Step/Recovery event source and a stable Pi correlation key.
