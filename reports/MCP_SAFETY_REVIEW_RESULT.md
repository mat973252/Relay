# MCP Safety Review Result — Fixes Before Step 6/7

Status: **fixes complete, stopped for review** per
`tasks/NEXT_ITERATION_MCP_SAFETY_FIXES.md`. No CI matrix, no secret-claim
sweep, no LICENSE/npm/remote/push/publish (Steps 6/7 and release remain
gated on this review).

Environment: WSL (Ubuntu) / Node v22.18.0 / pnpm 10.33.0 via corepack.
Host CLIs: Claude Code 2.1.281 (Windows binary invoked from WSL),
Codex 0.156.1 (Windows, via `cmd.exe` interop). No secrets appear in any
recorded output; the Codex auth copy lived only in a disposable temp
`CODEX_HOME` that was deleted with the proof workspace.

## 1. Implementation (what changed and why)

1. **Same-key linearization inside the owner** (`packages/mcp/src/server.ts`):
   every `relay_submit_action` / `relay_reconcile_operation` call for one
   journal key is appended to a per-key promise chain (FIFO — readline
   preserves arrival order). A second call for the same key cannot observe a
   half-settled state of the first, so an in-flight execution can no longer
   be marked FAILED by a concurrent not-found observation. Cross-key calls
   still run concurrently; cross-process safety is the single-writer lock.
2. **`relay_reconcile_operation` is non-creating and read-only for local
   states** (`server.ts`): it now looks the record up first. Absent key →
   explicit `{"status":"absent", ...}` result; PREPARED → explicit
   `{"status":"prepared", ...}` result telling the caller execution never
   began (continue with submit, same operationId). Neither path writes a row
   nor contacts the provider. Only SUBMITTED/UNKNOWN records run the
   reconcile state machine; CONFIRMED/FAILED return their terminal outcomes
   unchanged. The reconcile pre-check runs inside the same per-key chain, so
   it also cannot race an in-flight submission.
3. **Single owner remains true after takeover** (`packages/mcp/src/lock.ts`,
   redesigned twice — see "Review round 2" for the gap fix): the final
   protocol claims a succession and installs the new lock as ONE atomic
   replacement. Takeover of an observed stale body B: (1) hard-link
   SNAPSHOT of the current lock — if it is not exactly B, yield WITHOUT
   touching the lock (stealing a live owner's replacement lock is
   impossible; there is no "restore" path at all); (2) exclusive FENCE
   `link(claimant → mcp-owner.claim.<hash(B)>)` — gap-free, exactly one
   successor per succession; a fence whose claimant is provably dead (dead
   pid, or same-pid predecessor via startedAt) is recovered by a
   single-winner rename, foreign/unattributable claimants fail closed;
   (3) re-snapshot must still show B; (4) INSTALL via `rename(next → lock)`
   — the lock path is NEVER absent, so no third process can slip into a
   gap; (5) read-back verify. `settleMs` is gone entirely. `startedAt` is
   CHECKED: a lock naming our pid that this process did not write is
   attributed by it — written before this module booted ⇒ provably dead
   predecessor (pid reuse) ⇒ takeover; otherwise ⇒ fail closed. Malformed
   lock data fails CLOSED (no takeover of an unreadable lock; operator
   removes it). `releaseWorkspaceOwnership`
   deletes the lock only when the on-disk body is EXACTLY the body this
   process wrote and verified (pid + hostname + startedAt), so an old owner
   can never remove a successor's lock — including under pid reuse.
4. **Provider outcomes default to UNKNOWN** (`server.ts` + `actions.ts`):
   HTTP responses are ambiguous by default. Only statuses the operator lists
   in `http.rejectStatuses` (integers 400–499, explicit contract claim of
   pre-commit rejection) settle FAILED; every other non-2xx (409/408/5xx
   included), a non-parseable 2xx body, a network error, or a timeout
   resolves UNKNOWN with the do-not-resubmit instruction. Submit requests
   carry a bounded timeout (`http.timeoutMs`, default 30 s, max 600 s) via
   `AbortSignal.timeout` — bounded, but a timeout is never a FAILED.
   A missing secret env var remains a definitive pre-commit failure (nothing
   was sent).
5. **Recovery binds to a stable, observable operation**:
   - `runEffect` persists an optional non-secret `intent` (`intentJson` on
     `EffectRecord`; new `intent_json` column with guarded `ALTER TABLE`
     migration in `SqliteEffectJournal`). Intent is metadata, NOT identity —
     it is excluded from `requestHash`, so reconcile re-entry never depends
     on prose.
   - `relay_submit_action` accepts `intent` (≤ 500 chars);
     `relay_list_unresolved` now returns `key`, `actionId`, `operationId`,
     `status`, `updatedAt`, and the recorded `intent`, so a fresh session
     can pick the existing operation from the list alone (the skill text is
     guidance, not a guarantee — the list is the recovery surface).
   - Request identity now includes `actionFingerprint(action)` — a SHA-256
     over everything in the config that changes remote meaning (urls,
     method, headers, secret-header NAMES, reconcile shape). A config change
     refuses to reuse an existing operation id for a different remote effect
     ("refers to a different effect", fail closed).
   - `loadActions` requires `{operationId}` in BOTH the execute and the
     reconcile URL — endpoints that do not bind the operation id cannot
     anchor exactly-once and are rejected at startup (exit 78).
6. **Wording corrections**: `reports/PUBLIC_PROOF_RESULT.md` baseline commit
   fixed to `3ade92d`; the wsl.exe-bridging sentence now states that the
   TRACKED host entries document native node commands and a machine-local,
   untracked `.mcp.json` (generated by `install.mjs`), while the bridging
   belonged to the ad-hoc cross-host verification configs. Both host READMEs
   now record the actually-tested reproducible paths (Codex:
   `--approve-for-me` required in exec mode, wsl.exe bridge shape, stdin
   prompt; Claude Code: cross-OS note). Coverage claims stay narrowed:
   protection applies ONLY to actions executed through the relay tools —
   model-visible tools/hooks intercept nothing (arbitrary shell, built-in
   tools, other MCP servers are bypasses).

## 2. Reproducible local evidence

`corepack pnpm check` — typecheck + full suite:
**143 tests, 143 pass, 0 fail, 0 skipped** (epistemic 8, core 40,
artifact-fs 12, storage-sqlite 17, cli 33, **mcp 26**, adapter-pi 7).

Regression-first: every new safety test was run against the pre-fix code and
failed there before the fix landed —
`packages/mcp/test/safety.test.ts` (11 tests): concurrent same-key false
FAILED (reproduced: second submit raced the held pre-commit POST and the
journal ended FAILED/not-COMMITTED while the remote committed), reconcile
racing an in-flight submission, absent-key reconcile creating a row,
PREPARED-key reconcile mutating to FAILED, commit-then-409 and commit-then-408
settled FAILED, never-responding request hanging past any bound,
list without actionId/operationId/intent, config change silently reusing an
operation id, endpoints without `{operationId}` accepted;
`packages/mcp/test/lock.test.ts` (10 tests, was 3): malformed lock taken over
(fail-open), release deleting a successor's same-pid lock (startedAt
unchecked), pid-reuse predecessor lock stuck closed, the claim/install gap
(see "Review round 2"), plus the invariant
suite — two independent successor PROCESSES racing one stale lock over three
rounds yield exactly one owner whose pid the lock names, and a live owner is
respected during a concurrent takeover attempt (re-run 4×: stable).
The only new test that also passed pre-fix is the configured-rejection
FAILED case (an invariant both designs share).

Crash demo: `node examples/crash-demo.mjs` — 4/4 PASS, remote counter 1
(SIGKILL after remote commit; restart; read-only reconcile confirms).

## 2a. Review round 2 — the claim/install gap

The first redesign still had a two-step takeover: rename the stale lock to a
tombstone (claim), then `rm` the tombstone and `O_EXCL`-create the new lock
(install). Between the two steps the lock path was ABSENT:

- a third process arriving in the gap could `O_EXCL`-create and become the
  owner while the claimant was mid-protocol (an unclaimed owner leapfrogging
  the claim winner);
- worse, a successor with an older stale observation could blind-rename a
  LIVE lock installed in the gap, and its "restore" rename could clobber
  yet another creator's lock — two processes both believing they own;
- the attempt loop's exhaustion path could also return `held-elsewhere`
  after the claimant had itself written the lock.

Fix (as described in §1.3): snapshot-verify (hard link) before any write, an
exclusive link-fence per succession, and a single `rename` replacement as
the install — the lock path is never absent and there is no restore path
anywhere. The attempt loop cleans its own files on every exit path and
records ownership only after the post-install read-back.

Regression test (fails on the round-1 code, passes now): `takeover never
leaves the lock path absent; an attempt fired inside any absence cannot
leapfrog the claimant` — a watcher child busy-polls the lock path and
releases a third takeover attempt at the FIRST observed absence; asserts
`absentCount === 0`, the claimant is the one who acquired, the in-gap
attempter fails closed, and the final lock names the claimant. On the
round-1 code the watcher observed the lock absent during takeover
(reproduced: 1–2 absences per round) and the leapfrog path was live.
Stability: re-run 4× plus the full suite; the link-based protocol was also
verified manually on drvfs (`/mnt/d`, NTFS through 9p) where the real host
workspaces live.

## 3. Actual host calls against the fixed server

Shared setup: durable local counter provider (commits before answering,
state + request log on disk) at `http://127.0.0.1:8791`; workspace
`/mnt/d/relay-host-proof2` (= `D:\relay-host-proof2`, disposable, deleted
after evidence capture); server = WSL Node running
`packages/mcp/dist/src/main.js` — spawned by the Windows host CLIs through
`wsl.exe` bridging (Windows node cannot resolve WSL pnpm symlinks; same
limitation as the previous iteration, now documented in the host READMEs).

- **Claude Code 2.1.281** (`claude -p ... --mcp-config .mcp.json
  --strict-mcp-config --allowedTools mcp__relay__...`):
  1. First session: `relay_list_unresolved` → "no unresolved operations";
     submit (op `host-proof-claude-2027-03-08`, intent recorded) returned
     **UNKNOWN** — the proof provider had died after setup, so the bounded
     30 s fetch failed; the model did NOT resubmit and reported the journal
     record verbatim (status UNKNOWN, reason recorded). The conservative
     classification held in a real host loop (the reconcile tool was not in
     that call's allowedTools, so the session stopped there — approval
     boundary, not a server failure).
  2. Second session with reconcile allowed: list showed the structured entry
     (`actionId`/`operationId`/`status`/`intent`); reconcile proved the
     provider had no record → FAILED (true negative: the provider was down,
     nothing was committed); the model's re-submit with the SAME operationId
     was refused by the terminal-FAILED dedup — no automatic replay.
  3. Fresh operationId → CONFIRMED `{"ok":true,"value":1}`,
     `relay_get_operation` shows CONFIRMED with `intentJson` persisted.
- **Codex 0.156.1** (temp `CODEX_HOME`, `codex exec --skip-git-repo-check
  --approve-for-me -` with the prompt on stdin): model called
  `relay_list_unresolved` first ("no unresolved operations"), then
  `relay_submit_action` (op `host-proof-codex-2027-03-08`, intent recorded) →
  CONFIRMED `{"ok":true,"value":2}`, `relay_get_operation` CONFIRMED with
  intent. Without `--approve-for-me` every MCP call was blocked
  ("approval policy is never") and nothing executed — recorded in the Codex
  README now.
- Final provider state: counter **2** (one POST per confirmed operation per
  host; the request log shows exactly two POSTs and one reconcile GET — no
  hidden retries). Final journal: 1 FAILED (reconcile-proven true negative),
  2 CONFIRMED with intents.

## 4. Files changed this iteration

- `packages/core/src/effect.ts` (+`intent`/`intentJson`, optional under
  `exactOptionalPropertyTypes`), `packages/core/test/*` untouched.
- `packages/storage-sqlite/src/journal.ts` (`intent_json` column + guarded
  migration; insert/replaceAll/read wired).
- `packages/mcp/src/lock.ts` (atomic-claim redesign, startedAt attribution,
  malformed fail-closed, exact-body release), `packages/mcp/src/actions.ts`
  (endpoint binding, `rejectStatuses`, `timeoutMs`, `actionFingerprint`),
  `packages/mcp/src/server.ts` (per-key chain, non-creating reconcile,
  UNKNOWN-default classification, intent, structured list, fingerprint
  binding).
- Tests: `packages/mcp/test/safety.test.ts` (new), `lock.test.ts` (3→9),
  `helpers.ts` (new shared harness), `fixtures/mini-provider.ts` (pre-commit
  hold, commit-then-status, never-respond, request log),
  `fixtures/takeover-child.ts` and `fixtures/watch-lock-child.ts` (new),
  `mcp.test.ts` refactored onto helpers.
- Wording: `reports/PUBLIC_PROOF_RESULT.md`, both host READMEs.
- New: this report. `examples/crash-demo.mjs` unchanged and re-verified.

## 5. Remaining limitations (honest)

- The lock is local-machine serialization, not distributed locking: a
  foreign-host lock (WSL vs Windows on one shared directory) still fails
  closed and needs operator removal; pid liveness for OTHER pids cannot
  attribute reuse (only same-pid attribution via startedAt is decidable).
  The protocol relies on `rename` and hard-`link` atomicity of the local
  filesystem — verified on ext4 and drvfs/NTFS; NOT attempted on FAT/exFAT
  or network filesystems (no hard links there).
- Residual theoretical window (much narrower than any predecessor, stated
  for honesty): two protocol participants passing their final snapshot
  verification at the same instant and both installing could in principle
  interleave on a filesystem with non-linearizable rename; the fence makes
  this additionally require a provably-dead-claimant confusion. The SQLite
  unique effect key plus the PREPARED re-entry contract remain the deep
  backstop (as the task file itself notes).
- Crash litter: unique-named `mcp-owner.snap.*` / `next` / `claimant` files
  and a lingering `mcp-owner.claim.<hash>` fence are inert (a fence only
  gates a succession whose stale body no longer sits on the lock); legacy
  `mcp-owner.lock.stale.*` tombstones from the round-1 design are swept
  opportunistically after acquisition.
- `relay_reconcile_operation` maps a provider's proven "not found" to FAILED
  — correct only when the reconcile endpoint is truthful; a lying provider
  defeats it (documented since M1).
- The per-key chain serializes calls within ONE owner process; two live
  owners remain impossible by the lock, but a crashed owner's takeover
  trusts the journal's PREPARED/SUBMITTED contract exactly as before.
- Codex approval semantics are version-specific (`--approve-for-me` on
  0.156.1, same flag name as 0.147); Claude Code allowedTools gating can
  silence reconcile unless it is explicitly allowed — operator guidance,
  now noted in the host README.
- Windows/Node 24 full `pnpm check` was still not obtained in this
  iteration (WSL-built `node_modules` reparse points); that remains Step 6's
  CI matrix job, explicitly not claimed here.

## 6. Stop point

Stopped here per the task: no Step 6 (CI matrix), no Step 7 (secret-claim
README/report sweep beyond the corrections above), no LICENSE, no npm
publish, no remote creation, no push. Awaiting review.
