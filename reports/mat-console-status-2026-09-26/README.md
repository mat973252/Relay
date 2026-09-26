# mat-console status export — evidence artifacts (2026-09-26)

TEST DATA ONLY — generated from a synthetic journal built in a disposable
directory with fake ids/keys (`fx-*`, `fixture/*`, `fake-counter/*`). No real
journal, provider, or user data is present.

- `status.sample.json` — actual `relay status --output` output for a journal
  containing one CONFIRMED and one unresolved-UNKNOWN effect. Accepted by
  mat-console's `validateProjectStatus` (`src/contract/status.ts`).

Regenerate locally:

```bash
node packages/cli/dist/src/cli.js status --storage <journal.db> --output status.json
```
