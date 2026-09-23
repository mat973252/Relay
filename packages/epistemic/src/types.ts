/**
 * @relay/epistemic — durable epistemic state domain (Stage B).
 *
 * Minimal long-lived-agent cognition persistence:
 *   Investigation -> Claim -> Evidence -> Belief -> Delta -> Decision
 *
 * Dependency boundary (enforced): pure TypeScript domain + a storage port;
 * opaque references to artifacts/effects. No Pi imports, no model calls, no
 * scheduler/daemon, no UI, no knowledge graph.
 *
 * Core invariant: **No Delta, No Attention.** Attention items are derived
 * exclusively from Deltas; an `unchanged` delta records evidence and never
 * produces attention.
 */

export interface Investigation {
  id: string;
  title: string;
  /** What this investigation is trying to establish. */
  goal: string;
  /** Scope tag used to rebuild related beliefs (e.g. "project:relay"). */
  scope: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt: number | undefined;
}

/** A falsifiable statement under investigation. */
export interface Claim {
  id: string;
  investigationId: string;
  statement: string;
  createdAt: number;
}

/** Reference to inspectable evidence; content stays where it lives. */
export interface EvidenceRef {
  kind: "artifact" | "effect" | "source" | "observation";
  /** Opaque reference, e.g. artifact://sha256/<digest> or an effect key. */
  ref: string;
}

export interface Evidence {
  id: string;
  claimId: string;
  ref: EvidenceRef;
  /** true: the evidence supports the claim; false: it refutes it. */
  supports: boolean;
  observedAt: number;
}

/** Current acceptance state of a claim. */
export interface Belief {
  id: string;
  claimId: string;
  scope: string;
  /** 0..1 confidence in the claim. */
  confidence: number;
  status: "accepted" | "rejected" | "undetermined";
  basedOn: string[];
  updatedAt: number;
}

export type DeltaKind = "changed" | "unchanged" | "contradicted";

export interface Delta {
  id: string;
  beliefId: string;
  kind: DeltaKind;
  evidenceId: string;
  /** true only for changed/contradicted — the mechanized "No Delta, No Attention" rule. */
  attention: boolean;
  reason: string;
  at: number;
}

/** Human judgment record; only high-impact or unresolvable conflicts create one. */
export interface Decision {
  id: string;
  investigationId: string;
  summary: string;
  reason: "high-impact" | "unresolved-conflict";
  createdAt: number;
  resolvedAt: number | undefined;
}

/** Storage port; SQLite implementation lives in @relay/storage-sqlite. */
export interface EpistemicStore {
  createInvestigation(investigation: Investigation): Promise<void>;
  getInvestigation(id: string): Promise<Investigation | undefined>;

  addClaim(claim: Claim): Promise<void>;
  claims(investigationId: string): Promise<Claim[]>;

  addEvidence(evidence: Evidence): Promise<void>;
  evidenceFor(claimId: string): Promise<Evidence[]>;

  putBelief(belief: Belief): Promise<void>;
  beliefFor(claimId: string): Promise<Belief | undefined>;
  beliefsInScope(scope: string): Promise<Belief[]>;

  appendDelta(delta: Delta): Promise<void>;
  deltasForBelief(beliefId: string): Promise<Delta[]>;
  /** Derived view: only attention-bearing deltas. */
  attentionItems(): Promise<Delta[]>;

  putDecision(decision: Decision): Promise<void>;
  decisions(investigationId: string): Promise<Decision[]>;
}
