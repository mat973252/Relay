/**
 * @relay/epistemic — pure delta computation and decision gate.
 *
 * The delta rules are strict by construction:
 *   - evidence opposite to the current belief status -> contradicted (attention)
 *   - same direction, confidence move >= threshold      -> changed      (attention)
 *   - same direction, confidence move <  threshold      -> unchanged    (NO attention)
 *   - first evidence for an undetermined belief         -> changed      (attention)
 */
import type { Belief, Decision, Evidence } from "./types.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.1;

export interface DeltaComputation {
  kind: "changed" | "unchanged" | "contradicted";
  attention: boolean;
  reason: string;
  nextConfidence: number;
  nextStatus: Belief["status"];
}

const EPS = 1e-9;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Confidence update: each piece of evidence nudges confidence toward 1
 * (supports) or 0 (refutes) with geometrically decreasing step sizes so a
 * single late observation cannot overwhelm an established belief, while a
 * genuine reversal still crosses the contradiction rule.
 */
function nextConfidence(confidence: number, supports: boolean, evidenceCount: number): number {
  const step = 0.5 / Math.max(1, evidenceCount);
  return clamp01(supports ? confidence + (1 - confidence) * step : confidence - confidence * step);
}

export function computeDelta(
  belief: Belief,
  evidence: Evidence,
  evidenceCount: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): DeltaComputation {
  const accepted = belief.status === "accepted";
  if (belief.status === "undetermined") {
    return {
      kind: "changed",
      attention: true,
      reason: "first evidence resolved an undetermined belief",
      nextConfidence: evidence.supports ? 0.6 : 0.4,
      nextStatus: evidence.supports ? "accepted" : "rejected",
    };
  }
  if ((evidence.supports && !accepted) || (!evidence.supports && accepted)) {
    return {
      kind: "contradicted",
      attention: true,
      reason: `evidence ${evidence.supports ? "supports" : "refutes"} a ${belief.status} belief`,
      nextConfidence: belief.confidence,
      nextStatus: belief.status,
    };
  }
  const target = nextConfidence(belief.confidence, evidence.supports, evidenceCount);
  const moved = Math.abs(target - belief.confidence);
  if (moved >= threshold - EPS) {
    return {
      kind: "changed",
      attention: true,
      reason: `confidence moved ${moved.toFixed(3)} (>= ${threshold}) in the belief's direction`,
      nextConfidence: target,
      nextStatus: belief.status,
    };
  }
  return {
    kind: "unchanged",
    attention: false,
    reason: `confidence moved ${moved.toFixed(3)} (< ${threshold}); no attention`,
    nextConfidence: target,
    nextStatus: belief.status,
  };
}

export interface DecisionGateInput {
  impact: "high" | "low";
  /** Whether the conflict/state can be resolved automatically by policy. */
  autoResolvable: boolean;
}

/** Decision Gate: only high impact or non-auto-resolvable conflicts escalate. */
export function shouldRequireDecision(
  input: DecisionGateInput,
): { required: true; reason: Decision["reason"] } | { required: false } {
  if (input.impact === "high") return { required: true, reason: "high-impact" };
  if (!input.autoResolvable) return { required: true, reason: "unresolved-conflict" };
  return { required: false };
}
