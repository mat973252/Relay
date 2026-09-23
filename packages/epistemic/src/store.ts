/**
 * @relay/epistemic — domain service over the storage port.
 *
 * `recordEvidence` is the only mutation path for beliefs/deltas: it loads the
 * current belief, computes the delta with the pure rules, persists the
 * updated belief, and appends the delta. Attention items are never written
 * directly — they are a derived view over deltas ("No Delta, No Attention").
 */
import { randomUUID } from "node:crypto";
import { computeDelta } from "./delta.js";
import type { Belief, Claim, Decision, Delta, EpistemicStore, Evidence, Investigation } from "./types.js";

export interface RecordEvidenceInput {
  claimId: string;
  evidence: Omit<Evidence, "id" | "claimId"> & { id?: string };
  now?: () => number;
}

export interface RecordEvidenceResult {
  evidence: Evidence;
  belief: Belief;
  delta: Delta;
}

export async function recordEvidence(
  store: EpistemicStore,
  input: RecordEvidenceInput,
): Promise<RecordEvidenceResult> {
  const now = input.now ?? (() => Date.now());
  const evidence: Evidence = {
    id: input.evidence.id ?? randomUUID(),
    claimId: input.claimId,
    ref: input.evidence.ref,
    supports: input.evidence.supports,
    observedAt: input.evidence.observedAt ?? now(),
  };
  await store.addEvidence(evidence);

  const existing = await store.beliefFor(input.claimId);
  const evidenceSoFar = await store.evidenceFor(input.claimId);
  const scope = (await scopeForClaim(store, input.claimId)) ?? "unscoped";

  const belief: Belief =
    existing ?? {
      id: randomUUID(),
      claimId: input.claimId,
      scope,
      confidence: 0.5,
      status: "undetermined",
      basedOn: [],
      updatedAt: now(),
    };

  const computation = computeDelta(belief, evidence, evidenceSoFar.length);
  const updated: Belief = {
    ...belief,
    confidence: computation.nextConfidence,
    status: computation.nextStatus,
    basedOn: [...belief.basedOn, evidence.id],
    updatedAt: now(),
  };
  await store.putBelief(updated);

  const delta: Delta = {
    id: randomUUID(),
    beliefId: updated.id,
    kind: computation.kind,
    evidenceId: evidence.id,
    attention: computation.attention,
    reason: computation.reason,
    at: now(),
  };
  await store.appendDelta(delta);
  return { evidence, belief: updated, delta };
}

async function scopeForClaim(store: EpistemicStore, claimId: string): Promise<string | undefined> {
  // The scope is inherited from the belief's investigation via claim lookup;
  // stores that cannot resolve it return undefined and "unscoped" is used.
  const resolver = store as EpistemicStore & {
    claimById?: (id: string) => Promise<Claim | undefined>;
    investigationById?: (id: string) => Promise<{ scope: string } | undefined>;
  };
  const claim = resolver.claimById ? await resolver.claimById(claimId) : undefined;
  if (claim === undefined) return undefined;
  const investigation = resolver.investigationById
    ? await resolver.investigationById(claim.investigationId)
    : undefined;
  return investigation?.scope;
}

/** In-memory store for unit tests and ephemeral use. */
export class MemoryEpistemicStore implements EpistemicStore {
  private readonly investigations = new Map<string, import("./types.js").Investigation>();
  private readonly claimMap = new Map<string, Claim>();
  private readonly evidenceMap = new Map<string, Evidence>();
  private readonly beliefMap = new Map<string, Belief>();
  private readonly deltaMap = new Map<string, Delta>();
  private readonly decisionMap = new Map<string, Decision>();

  async createInvestigation(investigation: Investigation): Promise<void> {
    this.investigations.set(investigation.id, { ...investigation });
  }

  async getInvestigation(id: string): Promise<Investigation | undefined> {
    const found = this.investigations.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async addClaim(claim: Claim): Promise<void> {
    this.claimMap.set(claim.id, { ...claim });
  }

  async claims(investigationId: string): Promise<Claim[]> {
    return [...this.claimMap.values()].filter((c) => c.investigationId === investigationId);
  }

  async claimById(id: string): Promise<Claim | undefined> {
    const found = this.claimMap.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async investigationById(id: string): Promise<{ scope: string } | undefined> {
    return this.investigations.get(id);
  }

  async addEvidence(evidence: Evidence): Promise<void> {
    this.evidenceMap.set(evidence.id, { ...evidence });
  }

  async evidenceFor(claimId: string): Promise<Evidence[]> {
    return [...this.evidenceMap.values()].filter((e) => e.claimId === claimId);
  }

  async putBelief(belief: Belief): Promise<void> {
    this.beliefMap.set(belief.claimId, { ...belief });
  }

  async beliefFor(claimId: string): Promise<Belief | undefined> {
    const found = this.beliefMap.get(claimId);
    return found === undefined ? undefined : { ...found, basedOn: [...found.basedOn] };
  }

  async beliefsInScope(scope: string): Promise<Belief[]> {
    return [...this.beliefMap.values()].filter((b) => b.scope === scope);
  }

  async appendDelta(delta: Delta): Promise<void> {
    this.deltaMap.set(delta.id, { ...delta });
  }

  async deltasForBelief(beliefId: string): Promise<Delta[]> {
    return [...this.deltaMap.values()].filter((d) => d.beliefId === beliefId);
  }

  async attentionItems(): Promise<Delta[]> {
    return [...this.deltaMap.values()].filter((d) => d.attention);
  }

  async putDecision(decision: Decision): Promise<void> {
    this.decisionMap.set(decision.id, decision);
  }

  async decisions(investigationId: string): Promise<Decision[]> {
    return [...this.decisionMap.values()].filter((d) => d.investigationId === investigationId);
  }
}
