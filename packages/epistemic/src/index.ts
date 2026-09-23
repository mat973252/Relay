export type {
  Belief,
  Claim,
  Decision,
  Delta,
  DeltaKind,
  EpistemicStore,
  Evidence,
  EvidenceRef,
  Investigation,
} from "./types.js";
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  computeDelta,
  shouldRequireDecision,
  type DecisionGateInput,
  type DeltaComputation,
} from "./delta.js";
export { MemoryEpistemicStore, recordEvidence, type RecordEvidenceInput, type RecordEvidenceResult } from "./store.js";
