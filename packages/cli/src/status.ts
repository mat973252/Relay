/**
 * `relay status` — read-only producer of `mat-console.status/1`.
 *
 * Emits one JSON document describing what the LOCAL effect journal currently
 * shows. This is a sample of Relay-owned evidence, not a claim about the
 * project as a whole: aggregate counts only, health never above "unknown"
 * unless the journal itself shows attention-worthy evidence (unresolved
 * UNKNOWN effects or missing transition history). The document carries no
 * effect keys, ids, reasons, remote refs, payloads, or session/tool
 * identifiers — only counts, coverage labels, and timestamps.
 *
 * Contract: https://github.com/mat973252/mat-console/blob/main/docs/protocol-v1.md
 */
import type { EffectHistory, EffectStatus } from "@relay/core";

/** Consumer contract version this producer emits. */
export const STATUS_CONTRACT = "mat-console.status/1" as const;

const CONTRACT_DOC_URL =
  "https://github.com/mat973252/mat-console/blob/main/docs/protocol-v1.md";
const JOURNAL_DOC_URL =
  "https://github.com/mat973252/Relay/blob/main/docs/ARCHITECTURE.md";

export interface StatusAttention {
  id: string;
  title: string;
  detail?: string;
  severity: "info" | "warn" | "blocked";
  evidence_url?: string;
}

export interface StatusDocument {
  contract: typeof STATUS_CONTRACT;
  generated_at: string;
  ttl_seconds?: number;
  project: { id: string; name: string; summary?: string };
  source?: { label?: string; url?: string; evidence_url?: string };
  health?: { state: "ok" | "attention" | "degraded" | "unknown"; summary?: string };
  progress?: { percent: number; basis?: string };
  milestones?: unknown[];
  runs?: unknown[];
  attention?: StatusAttention[];
}

export interface JournalSample {
  /** Effect histories from a consistent read-only snapshot of the journal. */
  histories: EffectHistory[];
  /**
   * Why the journal could not be sampled (missing file, not a Relay journal,
   * corrupt/unreadable). Generic wording only — it may end up in a public
   * document, so callers must not put paths, keys, or error text from the
   * journal itself here.
   */
  unavailableReason?: string | undefined;
}

const STATUS_ORDER: EffectStatus[] = ["PREPARED", "SUBMITTED", "CONFIRMED", "FAILED", "UNKNOWN"];

function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function countStatuses(histories: EffectHistory[]): Map<EffectStatus, number> {
  const counts = new Map<EffectStatus, number>(STATUS_ORDER.map((s) => [s, 0]));
  for (const h of histories) counts.set(h.record.status, (counts.get(h.record.status) ?? 0) + 1);
  return counts;
}

function describeCounts(counts: Map<EffectStatus, number>): string {
  const parts: string[] = [];
  for (const status of STATUS_ORDER) {
    const n = counts.get(status) ?? 0;
    if (n > 0) parts.push(`${n} ${status.toLowerCase()}`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Build the status document from one journal sample. `generatedAt` is the
 * export time — the journal's own latest write is reported separately in the
 * summary so a fresh export never looks like fresh evidence.
 */
export function buildStatusDocument(sample: JournalSample, generatedAt: Date): StatusDocument {
  const document: StatusDocument = {
    contract: STATUS_CONTRACT,
    generated_at: generatedAt.toISOString(),
    ttl_seconds: 300,
    project: {
      id: "relay",
      name: "Relay",
      summary: "Durable execution-continuity layer — local effect-journal sample.",
    },
    source: {
      label: "relay status (local journal export)",
      evidence_url: CONTRACT_DOC_URL,
    },
  };

  if (sample.unavailableReason !== undefined) {
    document.health = {
      state: "unknown",
      summary: "effect journal unavailable; no local effect evidence was sampled",
    };
    document.attention = [
      {
        id: "journal-unavailable",
        title: "Relay effect journal unavailable",
        detail: sample.unavailableReason,
        severity: "warn",
        evidence_url: JOURNAL_DOC_URL,
      },
    ];
    return document;
  }

  const histories = sample.histories;
  const counts = countStatuses(histories);
  const coverage = { observed: 0, partial: 0, unavailable: 0 };
  let latestWrite: number | undefined;
  for (const h of histories) {
    coverage[h.coverage] += 1;
    latestWrite = Math.max(latestWrite ?? 0, h.record.updatedAt, h.events.at(-1)?.at ?? 0);
  }

  const attention: StatusAttention[] = [];
  const unknownCount = counts.get("UNKNOWN") ?? 0;
  if (unknownCount > 0) {
    attention.push({
      id: "unresolved-unknown-effects",
      title: `${unknownCount} effect${unknownCount === 1 ? "" : "s"} unresolved in UNKNOWN`,
      detail:
        "Relay does not silently retry an effect whose remote outcome is unknowable; " +
        "these require explicit reconciliation. Counts only — keys, ids and reasons " +
        "stay in the journal.",
      severity: "warn",
      evidence_url: JOURNAL_DOC_URL,
    });
  }
  const historyGap = coverage.partial + coverage.unavailable;
  if (historyGap > 0) {
    attention.push({
      id: "history-coverage-gap",
      title: `${historyGap} of ${histories.length} effects lack complete transition history`,
      detail:
        `${coverage.unavailable} unavailable, ${coverage.partial} partial — legacy rows or ` +
        "snapshot-only imports carry no append-only events; coverage is labeled, never backfilled.",
      severity: "info",
      evidence_url: JOURNAL_DOC_URL,
    });
  }
  if (attention.length > 0) document.attention = attention;

  const recency =
    latestWrite === undefined ? "" : `; latest journal write ${isoUtc(latestWrite)}`;
  if (histories.length === 0) {
    document.health = {
      state: "unknown",
      summary: "local effect journal contains no effect records",
    };
    return document;
  }

  const needsAttention = unknownCount > 0 || historyGap > 0;
  document.health = {
    // Never "ok": a clean journal sample is not evidence of production health.
    state: needsAttention ? "attention" : "unknown",
    summary:
      `local journal sample: ${histories.length} effects (${describeCounts(counts)}); ` +
      `transition history observed for ${coverage.observed} of ${histories.length}${recency}. ` +
      "Local journal evidence only — not a production-readiness claim.",
  };
  return document;
}
