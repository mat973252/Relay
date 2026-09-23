/**
 * Stage B epistemic domain tests:
 *  - Claim -> Evidence -> Belief, rebuildable by id and by scope
 *  - Knowledge Delta: strict changed/unchanged/contradicted; unchanged never
 *    produces attention ("No Delta, No Attention")
 *  - Decision Gate: only high impact or non-auto-resolvable conflicts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryEpistemicStore,
  computeDelta,
  recordEvidence,
  shouldRequireDecision,
  type Belief,
  type Evidence,
} from "../src/index.js";

let clock = 1_000;
const now = () => clock++;

function seedBelief(overrides: Partial<Belief> = {}): Belief {
  return {
    id: "b-1",
    claimId: "c-1",
    scope: "project:relay",
    confidence: 0.8,
    status: "accepted",
    basedOn: ["e-0"],
    updatedAt: 1,
    ...overrides,
  };
}

function seedEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "e-1",
    claimId: "c-1",
    ref: { kind: "observation", ref: "test://t1" },
    supports: true,
    observedAt: 2,
    ...overrides,
  };
}

describe("Claim -> Evidence -> Belief (rebuildable)", () => {
  it("belief is reconstructable by claim id and by scope after recording evidence", async () => {
    const store = new MemoryEpistemicStore();
    await store.createInvestigation({
      id: "inv-1",
      title: "Does the effect guard prevent duplicates?",
      goal: "Establish crash-safety of the effect journal",
      scope: "project:relay",
      status: "open",
      createdAt: now(),
      closedAt: undefined,
    });
    await store.addClaim({
      id: "c-1",
      investigationId: "inv-1",
      statement: "A SIGKILL after remote commit never duplicates the counter",
      createdAt: now(),
    });

    const { delta } = await recordEvidence(store, {
      claimId: "c-1",
      evidence: {
        ref: { kind: "artifact", ref: "artifact://sha256/" + "a".repeat(64) },
        supports: true,
        observedAt: now(),
      },
      now,
    });
    assert.equal(delta.kind, "changed"); // first evidence resolves undetermined

    const byClaim = await store.beliefFor("c-1");
    assert.ok(byClaim !== undefined);
    assert.equal(byClaim.status, "accepted");
    assert.equal(byClaim.scope, "project:relay");
    assert.equal(byClaim.basedOn.length, 1);

    const byScope = await store.beliefsInScope("project:relay");
    assert.equal(byScope.length, 1);
    assert.equal(byScope[0]?.claimId, "c-1");

    const evidence = await store.evidenceFor("c-1");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.ref.kind, "artifact");
  });
});

describe("Knowledge Delta (strict rules)", () => {
  it("first evidence on an undetermined belief is changed with attention", () => {
    const result = computeDelta(seedBelief({ status: "undetermined", confidence: 0.5 }), seedEvidence({ supports: true }), 1);
    assert.equal(result.kind, "changed");
    assert.equal(result.attention, true);
    assert.equal(result.nextStatus, "accepted");
  });

  it("opposite evidence contradicts an accepted belief", () => {
    const result = computeDelta(seedBelief(), seedEvidence({ supports: false }), 2);
    assert.equal(result.kind, "contradicted");
    assert.equal(result.attention, true);
    assert.equal(result.nextStatus, "accepted"); // status flips only via reconciliation policy
  });

  it("supporting evidence beyond the threshold is changed with attention", () => {
    const belief = seedBelief({ confidence: 0.5 });
    // With 1 evidence so far the step is 0.25 -> moves 0.125 >= 0.1 threshold.
    const result = computeDelta(belief, seedEvidence({ supports: true }), 1, 0.1);
    assert.equal(result.kind, "changed");
    assert.equal(result.attention, true);
    assert.ok(result.nextConfidence > belief.confidence);
  });

  it("tiny confidence moves are unchanged WITHOUT attention (No Delta, No Attention)", () => {
    const belief = seedBelief({ confidence: 0.95 });
    // Late supporting evidence on an established belief moves < 0.1.
    const result = computeDelta(belief, seedEvidence({ supports: true }), 20, 0.1);
    assert.equal(result.kind, "unchanged");
    assert.equal(result.attention, false);
    assert.match(result.reason, /no attention/);
  });

  it("attention view contains only attention-bearing deltas", async () => {
    const store = new MemoryEpistemicStore();
    const belief = seedBelief({ id: "b-2", confidence: 0.95, basedOn: [] });
    await store.putBelief(belief);
    // unchanged delta
    await recordEvidence(store, {
      claimId: belief.claimId,
      evidence: { ref: { kind: "observation", ref: "test://u" }, supports: true, observedAt: 1 },
      now,
    });
    // contradicted delta
    await recordEvidence(store, {
      claimId: belief.claimId,
      evidence: { ref: { kind: "observation", ref: "test://x" }, supports: false, observedAt: 2 },
      now,
    });
    const attention = await store.attentionItems();
    assert.equal(attention.length, 1);
    assert.equal(attention[0]?.kind, "contradicted");
  });
});

describe("Decision Gate", () => {
  it("high impact always requires a decision", () => {
    assert.deepEqual(shouldRequireDecision({ impact: "high", autoResolvable: true }), {
      required: true,
      reason: "high-impact",
    });
  });

  it("low impact requires a decision only when not auto-resolvable", () => {
    assert.deepEqual(shouldRequireDecision({ impact: "low", autoResolvable: true }), { required: false });
    assert.deepEqual(shouldRequireDecision({ impact: "low", autoResolvable: false }), {
      required: true,
      reason: "unresolved-conflict",
    });
  });
});
