# Windows dead-claimant fence transfer — result

Date: 2026-09-25. Stage: `tasks/NEXT_ITERATION_WINDOWS_FENCE_TRANSFER.md`. Base: `e01d2bb`.
Branch: `devin/safety-windows-fence`.

## Implemented behavior

`packages/mcp/src/lock.ts` — dead-claimant fence transfer redesigned so that
**no rename or unlink ever targets a claim path**.

Previously, transferring a dead claimant's fence was a single
`rename(claimantTmp, fence)` — an atomic replace on POSIX, but on Windows
(Node 24.13, NTFS via `MoveFileExW`/`MOVEFILE_REPLACE_EXISTING`) a rename
that replaces an existing path can be denied with `EPERM` when the target
inode is multiply-linked or transiently opened by a racing process — exactly
what the concurrent `link(fence, fsnap)` snapshot and cross-process reads
produce. The uncaught throw killed the child before it could report, so the
test timed out.

The transfer is now an **append-only claim chain**:

- Level 0 stays `mcp-owner.claim.<hash(B)>` (unchanged name — the existing
  fence watcher contract still holds).
- When the current deepest claimant is provably dead, the claim advances one
  level: `mcp-owner.claim.<hash(B)>.t<k+1>`, created by a fresh exclusive
  `link(claimant, path)` (EEXIST = lost the level, re-read it). Nothing is
  renamed, overwritten, or deleted, so no claim file is ever absent once
  created: protection is continuous on every filesystem that supports
  exclusive hard-link create.
- A live or unattributable claimant at the deepest level fails closed, as
  before. Malformed claim data fails closed. Chain depth is bounded
  (`MAX_CLAIM_LEVEL = 32`; beyond that is pathological and fails closed).
- The only remaining rename in the protocol is the install,
  `rename(next, lock)`: the stale body is re-read before EVERY attempt so a
  changed lock is never renamed over, and transient EPERM/EACCES/EBUSY is
  retried (30 × 15 ms) before failing closed — our held claim keeps the
  succession protected while retrying.
- Hard-link snapshot reads (`snap`/`fsnap` files) were removed: plain
  `readFile` + body equality provides the same "still exactly B" guarantee
  without leaving extra links on the lock inode during the install rename —
  the multiply-linked-target condition that Windows rejects.
- Claim files are never swept (permanent audit trail per succession);
  opportunistic litter sweep now covers `next`/`claimant`/`snap`/`fsnap`
  debris and legacy `mcp-owner.lock.stale.*` tombstones.
- All filesystem errors inside an ownership attempt now fail closed
  (`held-elsewhere`) instead of throwing — a takeover child can no longer
  exit without reporting.

Safety invariants preserved: the lock path is never absent during takeover;
exactly one process can hold the deepest claim level; takeover is verified
against the exact observed stale body; ambiguity fails closed; a live
owner's lock is never clobbered; release still removes only the exact
verified body.

## API decisions

- `takeWorkspaceOwnership(dir, { now?, rename? })` gained an optional
  `rename` seam — the only change to the public surface — used by tests to
  inject filesystem-failure semantics (Windows EPERM) deterministically.

## Regression-first evidence (simulated — labeled)

This VM is Linux-only, so there is no native Windows verification; the
independently reproduced Windows error (EPERM on `rename(claimantTmp,
fence)`) is the reproduction evidence. Deterministic local regression:

- `SIMULATED Windows EPERM: takeover succeeds on a filesystem that denies
  rename-replace on claim paths` — injects EPERM for any rename targeting
  `mcp-owner.claim.*`. **Before the fix: fails** (the uncaught EPERM
  propagates out of `takeWorkspaceOwnership` — the exact reported crash
  class). **After: passes** — the fence is never renamed.
- `SIMULATED transient EPERM on the install rename is retried; a changed
  lock is never renamed over` — **before: fails** (first denial returned
  `held-elsewhere` permanently). **After: passes** (bounded retry).
- `a second dead claimant advances the claim chain instead of renaming over
  the first fence` — chained double-death transfer.
- `a live claimant at the transfer level still fails closed` — no leapfrog
  via the chain.

## Tests run

| Command | Env | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Node 24.19.0 / pnpm 10.33.0 | OK |
| `npx tsc -b packages/cli && pnpm typecheck` (pre-existing CLI-first build-order workaround) | Node 24.19.0 | OK |
| `node --test dist/test/lock.test.js` (×3) | Node 24.19.0 | 15/15 pass each run |
| `pnpm --filter @relay/mcp test` | Node 24.19.0 | 45/45 pass |
| `pnpm --filter @relay/adapter-pi test` | Node 24.19.0 | 7/7 pass |
| `node examples/crash-demo.mjs` | Node 24.19.0 | 4/4 PASS, remote counter 1 |
| `pnpm typecheck` | Node 22.23.3 | OK |
| `node --test dist/test/lock.test.js` | Node 22.23.3 | 15/15 pass |
| `pnpm --filter @relay/mcp test` | Node 22.23.3 | 45/45 pass |
| `node examples/crash-demo.mjs` | Node 22.23.3 | 4/4 PASS |
| Other packages on Node 22: epistemic 8/8, core 40/40, artifact-fs 12/12, storage-sqlite 17/17, adapter-pi 7/7 | Node 22.23.3 | pass |
| `git diff --check` | — | clean |

Full-repo `pnpm -r test`: **9 pre-existing environmental failures in
`@relay/cli`** on this VM — the `doctor` capability probe requires `pi` on
PATH and this machine has none (adapter-pi's tests locate the pi bundle via
node_modules instead, and pass). All 9 cli failures cite
`pi CLI not available on PATH` / doctor summary `fail`; unrelated to the
lock module (cli does not import it). Everything else passes.

## Files changed

- `packages/mcp/src/lock.ts` — claim-chain transfer, install retry with
  per-attempt re-verify, snapshots removed, debris sweep, fail-closed errors.
- `packages/mcp/test/lock.test.ts` — 4 new regression tests (fence-transfer
  describe block), shared `fenceName` helper.

## Remaining limits

- **No native Windows verification** — simulated EPERM evidence only. Codex
  must re-run the Windows Node 24.13 suite before merge.
- The install rename keeps a small residual exposure: on Windows, a
  persistent (non-transient) extra link/handle on the lock inode would make
  install fail closed rather than acquire — safe but unavailable; operator
  removes the litter.
- Chain depth bound 32; a deeper chain fails closed.
- The pre-existing cli/adapters build-order workaround and the `pi`-on-PATH
  doctor requirement are unchanged and out of scope.
- Does not clear the broader Relay safety gate, Step 6/7, publishing, or
  AgentLens.
