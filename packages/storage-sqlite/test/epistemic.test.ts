/**
 * Stage B SQLite integration: epistemic facts survive close/reopen; beliefs
 * rebuild by claim id and by scope; attention view derives from deltas only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SqliteEpistemicStore } from "../src/epistemic-store.js";
import { recordEvidence } from "@relay/epistemic";

const tmp = mkdtempSync(join(tmpdir(), "relay-epistemic-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let clock = 1_000;
const now = () => clock++;

describe("SqliteEpistemicStore", () => {
  it("rejects claims without an investigation", async () => {
    const store = await SqliteEpistemicStore.open({ path: join(tmp, "foreign-keys.db") });
    try {
      await assert.rejects(
        () => store.addClaim({ id: "orphan", investigationId: "missing", statement: "orphan", createdAt: now() }),
        /FOREIGN KEY/,
      );
    } finally {
      store.close();
    }
  });

  it("persists investigation/claim/evidence/belief/delta/decision across reopen", async () => {
    const dbPath = join(tmp, "epistemic.db");
    const store = await SqliteEpistemicStore.open({ path: dbPath });
    await store.createInvestigation({
      id: "inv-1",
      title: "Migration safety",
      goal: "Establish that capsules never duplicate effects",
      scope: "project:relay",
      status: "open",
      createdAt: now(),
      closedAt: undefined,
    });
    await store.addClaim({
      id: "claim-1",
      investigationId: "inv-1",
      statement: "Migrated SUBMITTED effects reconcile without duplicate remote work",
      createdAt: now(),
    });
    const first = await recordEvidence(store, {
      claimId: "claim-1",
      evidence: {
        ref: { kind: "effect", ref: "counter/live:1" },
        supports: true,
        observedAt: now(),
      },
      now,
    });
    assert.equal(first.delta.kind, "changed");
    assert.equal(first.delta.attention, true);

    const decision = {
      id: "dec-1",
      investigationId: "inv-1",
      summary: "Adopt single-writer migration policy",
      reason: "high-impact" as const,
      createdAt: now(),
      resolvedAt: undefined,
    };
    await store.putDecision(decision);
    store.close();

    const reopened = await SqliteEpistemicStore.open({ path: dbPath });
    try {
      // Belief rebuildable by claim id.
      const belief = await reopened.beliefFor("claim-1");
      assert.ok(belief !== undefined);
      assert.equal(belief.status, "accepted");
      assert.equal(belief.scope, "project:relay");
      assert.deepEqual(belief.basedOn, [first.evidence.id]);

      // Belief rebuildable by scope.
      const scoped = await reopened.beliefsInScope("project:relay");
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0]?.claimId, "claim-1");

      // Deltas and derived attention view.
      const deltas = await reopened.deltasForBelief(belief.id);
      assert.equal(deltas.length, 1);
      assert.equal((await reopened.attentionItems()).length, 1);

      // Evidence and claims survive with references intact.
      const evidence = await reopened.evidenceFor("claim-1");
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.ref.kind, "effect");
      const claims = await reopened.claims("inv-1");
      assert.equal(claims.length, 1);

      // Decisions survive.
      const decisions = await reopened.decisions("inv-1");
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.reason, "high-impact");
    } finally {
      reopened.close();
    }
  });
});
