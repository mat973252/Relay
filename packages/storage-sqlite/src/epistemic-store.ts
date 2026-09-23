/**
 * @relay/storage-sqlite — durable epistemic repository (Stage B).
 *
 * SQLite implementation of the @relay/epistemic storage port. Beliefs are
 * rebuildable by claim id and scope after close/reopen (durable facts, never
 * narrated state).
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Belief,
  Claim,
  Decision,
  Delta,
  EpistemicStore,
  Evidence,
  Investigation,
} from "@relay/epistemic";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_investigations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS relay_claims (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES relay_investigations(id),
  statement TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES relay_claims(id),
  ref_kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  supports INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_beliefs (
  claim_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','undetermined')),
  based_on TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_deltas (
  id TEXT PRIMARY KEY,
  belief_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('changed','unchanged','contradicted')),
  evidence_id TEXT NOT NULL,
  attention INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_decisions (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES relay_investigations(id),
  summary TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('high-impact','unresolved-conflict')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
`;

interface InvestigationRow {
  id: string;
  title: string;
  goal: string;
  scope: string;
  status: string;
  created_at: number;
  closed_at: number | null;
}

interface ClaimRow {
  id: string;
  investigation_id: string;
  statement: string;
  created_at: number;
}

interface EvidenceRow {
  id: string;
  claim_id: string;
  ref_kind: string;
  ref: string;
  supports: number;
  observed_at: number;
}

interface BeliefRow {
  claim_id: string;
  id: string;
  scope: string;
  confidence: number;
  status: string;
  based_on: string;
  updated_at: number;
}

interface DeltaRow {
  id: string;
  belief_id: string;
  kind: string;
  evidence_id: string;
  attention: number;
  reason: string;
  at: number;
}

interface DecisionRow {
  id: string;
  investigation_id: string;
  summary: string;
  reason: string;
  created_at: number;
  resolved_at: number | null;
}

export interface SqliteEpistemicStoreOptions {
  path: string;
}

export class SqliteEpistemicStore implements EpistemicStore {
  private readonly db: import("node:sqlite").DatabaseSync;

  private constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
  }

  static async open(options: SqliteEpistemicStoreOptions): Promise<SqliteEpistemicStore> {
    const sqlite = await import("node:sqlite");
    await mkdir(dirname(options.path), { recursive: true });
    const db = new sqlite.DatabaseSync(options.path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec(SCHEMA);
    return new SqliteEpistemicStore(db);
  }

  close(): void {
    this.db.close();
  }

  async createInvestigation(investigation: Investigation): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO relay_investigations (id, title, goal, scope, status, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        investigation.id,
        investigation.title,
        investigation.goal,
        investigation.scope,
        investigation.status,
        investigation.createdAt,
        investigation.closedAt ?? null,
      );
  }

  async getInvestigation(id: string): Promise<Investigation | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_investigations WHERE id = ?").get(id) as
      | InvestigationRow
      | undefined;
    return row === undefined ? undefined : toInvestigation(row);
  }

  async addClaim(claim: Claim): Promise<void> {
    this.db
      .prepare("INSERT INTO relay_claims (id, investigation_id, statement, created_at) VALUES (?, ?, ?, ?)")
      .run(claim.id, claim.investigationId, claim.statement, claim.createdAt);
  }

  async claims(investigationId: string): Promise<Claim[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_claims WHERE investigation_id = ? ORDER BY created_at, id")
      .all(investigationId) as unknown as ClaimRow[];
    return rows.map((row) => ({
      id: row.id,
      investigationId: row.investigation_id,
      statement: row.statement,
      createdAt: row.created_at,
    }));
  }

  async claimById(id: string): Promise<Claim | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_claims WHERE id = ?").get(id) as ClaimRow | undefined;
    return row === undefined
      ? undefined
      : { id: row.id, investigationId: row.investigation_id, statement: row.statement, createdAt: row.created_at };
  }

  async investigationById(id: string): Promise<{ scope: string } | undefined> {
    const row = this.db.prepare("SELECT scope FROM relay_investigations WHERE id = ?").get(id) as
      | { scope: string }
      | undefined;
    return row;
  }

  async addEvidence(evidence: Evidence): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO relay_evidence (id, claim_id, ref_kind, ref, supports, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        evidence.id,
        evidence.claimId,
        evidence.ref.kind,
        evidence.ref.ref,
        evidence.supports ? 1 : 0,
        evidence.observedAt,
      );
  }

  async evidenceFor(claimId: string): Promise<Evidence[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_evidence WHERE claim_id = ? ORDER BY observed_at, id")
      .all(claimId) as unknown as EvidenceRow[];
    return rows.map((row) => ({
      id: row.id,
      claimId: row.claim_id,
      ref: { kind: row.ref_kind as Evidence["ref"]["kind"], ref: row.ref },
      supports: row.supports === 1,
      observedAt: row.observed_at,
    }));
  }

  async putBelief(belief: Belief): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relay_beliefs (claim_id, id, scope, confidence, status, based_on, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(claim_id) DO UPDATE SET
           confidence = excluded.confidence,
           status = excluded.status,
           based_on = excluded.based_on,
           updated_at = excluded.updated_at`,
      )
      .run(
        belief.claimId,
        belief.id,
        belief.scope,
        belief.confidence,
        belief.status,
        JSON.stringify(belief.basedOn),
        belief.updatedAt,
      );
  }

  async beliefFor(claimId: string): Promise<Belief | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_beliefs WHERE claim_id = ?").get(claimId) as
      | BeliefRow
      | undefined;
    return row === undefined ? undefined : toBelief(row);
  }

  async beliefsInScope(scope: string): Promise<Belief[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_beliefs WHERE scope = ? ORDER BY updated_at, id")
      .all(scope) as unknown as BeliefRow[];
    return rows.map(toBelief);
  }

  async appendDelta(delta: Delta): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO relay_deltas (id, belief_id, kind, evidence_id, attention, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(delta.id, delta.beliefId, delta.kind, delta.evidenceId, delta.attention ? 1 : 0, delta.reason, delta.at);
  }

  async deltasForBelief(beliefId: string): Promise<Delta[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_deltas WHERE belief_id = ? ORDER BY at, id")
      .all(beliefId) as unknown as DeltaRow[];
    return rows.map((row) => ({
      id: row.id,
      beliefId: row.belief_id,
      kind: row.kind as Delta["kind"],
      evidenceId: row.evidence_id,
      attention: row.attention === 1,
      reason: row.reason,
      at: row.at,
    }));
  }

  async attentionItems(): Promise<Delta[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_deltas WHERE attention = 1 ORDER BY at, id")
      .all() as unknown as DeltaRow[];
    return rows.map((row) => ({
      id: row.id,
      beliefId: row.belief_id,
      kind: row.kind as Delta["kind"],
      evidenceId: row.evidence_id,
      attention: row.attention === 1,
      reason: row.reason,
      at: row.at,
    }));
  }

  async putDecision(decision: Decision): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO relay_decisions (id, investigation_id, summary, reason, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        decision.id,
        decision.investigationId,
        decision.summary,
        decision.reason,
        decision.createdAt,
        decision.resolvedAt ?? null,
      );
  }

  async decisions(investigationId: string): Promise<Decision[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_decisions WHERE investigation_id = ? ORDER BY created_at, id")
      .all(investigationId) as unknown as DecisionRow[];
    return rows.map((row) => ({
      id: row.id,
      investigationId: row.investigation_id,
      summary: row.summary,
      reason: row.reason as Decision["reason"],
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
    }));
  }
}

function toInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    scope: row.scope,
    status: row.status as Investigation["status"],
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
  };
}

function toBelief(row: BeliefRow): Belief {
  return {
    id: row.id,
    claimId: row.claim_id,
    scope: row.scope,
    confidence: row.confidence,
    status: row.status as Belief["status"],
    basedOn: JSON.parse(row.based_on) as string[],
    updatedAt: row.updated_at,
  };
}
