export { RELAY_VERSION } from "./version.js";
export {
  doctorExitCode,
  runDoctor,
  worstStatus,
  type CheckStatus,
  type DoctorCheck,
  type DoctorContext,
  type DoctorExitCode,
  type DoctorProbeSpec,
  type DoctorResult,
  type ProbeOutcome,
  type RunDoctorInput,
} from "./doctor.js";
export { formatDoctorJson, formatDoctorReport } from "./format.js";
export {
  AmbiguousEffectError,
  EffectNeedsReconciliationError,
  SimulatedProcessDeath,
  hashRequest,
  runEffect,
  stableStringify,
  type CrashInjection,
  type CrashPoint,
  type EffectExecuteContext,
  type EffectJournal,
  type EffectOutcome,
  type EffectRecord,
  type EffectStatus,
  type InFlightCrashPoint,
  type ReconcileOutcome,
  type ReplayPolicy,
  type RunEffectInput,
  type RunnerCrashPoint,
} from "./effect.js";
export {
  activationExitCode,
  evaluateCapabilities,
  type ActivationDecision,
  type CapabilityCheckSpec,
  type CapabilityEvaluation,
  type CapabilityProbe,
  type CapabilityProbeOutcome,
  type CapabilityResult,
  type CapabilitySpec,
  type CapabilityState,
} from "./capabilities.js";
export {
  CAPSULE_ROOT,
  validateManifest,
  type CapsuleFileEntry,
  type CapsuleManifest,
  type MigrationEvidence,
} from "./capsule.js";
