/**
 * @relay/core — capability contract domain (M3).
 *
 * A capability contract declares what an environment must provide before a
 * Relay-attached Pi session may (re)activate. Config is data (parsed from
 * human-authored YAML elsewhere); evaluation is pure orchestration over
 * injected probes. Secret *references* are names, never values.
 */

export type CapabilityState = "AVAILABLE" | "DEGRADED" | "MISSING" | "DENIED";

export type ActivationDecision = "READY" | "DEGRADED" | "BLOCKED";

/** Data-only description of how to probe a capability. */
export type CapabilityCheckSpec =
  | { kind: "command-on-path"; command: string; versionPattern?: string }
  | { kind: "node-module"; module: string }
  | { kind: "http"; url: string; secretHeaders?: Record<string, string> }
  | { kind: "env-ref"; env: string }
  | { kind: "custom"; id: string };

export interface CapabilitySpec {
  id: string;
  label: string;
  required: boolean;
  description?: string | undefined;
  check: CapabilityCheckSpec;
}

export interface CapabilityProbeOutcome {
  state: CapabilityState;
  detail: string;
}

export interface CapabilityResult {
  id: string;
  label: string;
  required: boolean;
  state: CapabilityState;
  detail: string;
}

export interface CapabilityEvaluation {
  schema: "relay.capability-evaluation/1";
  results: CapabilityResult[];
  decision: ActivationDecision;
}

export type CapabilityProbe = () => Promise<CapabilityProbeOutcome>;

export interface EvaluateCapabilitiesInput {
  specs: CapabilitySpec[];
  /** Probes by capability id; a missing probe for a spec is a configuration error. */
  probes: Map<string, CapabilityProbe>;
}

function probeError(err: unknown): CapabilityProbeOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return { state: "MISSING", detail: `probe error: ${message}` };
}

/**
 * Deterministic evaluation:
 *   - any REQUIRED capability not AVAILABLE  => BLOCKED (activation refused)
 *   - otherwise any DEGRADED / optional MISSING => DEGRADED (runnable)
 *   - otherwise READY
 */
export async function evaluateCapabilities(
  input: EvaluateCapabilitiesInput,
): Promise<CapabilityEvaluation> {
  const seen = new Set<string>();
  const results: CapabilityResult[] = [];
  for (const spec of input.specs) {
    if (seen.has(spec.id)) throw new Error(`duplicate capability id: ${spec.id}`);
    seen.add(spec.id);
    const probe = input.probes.get(spec.id);
    if (probe === undefined) {
      results.push({
        id: spec.id,
        label: spec.label,
        required: spec.required,
        state: "MISSING",
        detail: "no probe registered for capability",
      });
      continue;
    }
    const outcome = await probe().catch(probeError);
    results.push({
      id: spec.id,
      label: spec.label,
      required: spec.required,
      state: outcome.state,
      detail: outcome.detail,
    });
  }
  results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const blocked = results.some((r) => r.required && r.state !== "AVAILABLE");
  const degraded = results.some((r) => r.state !== "AVAILABLE");
  const decision: ActivationDecision = blocked ? "BLOCKED" : degraded ? "DEGRADED" : "READY";
  return { schema: "relay.capability-evaluation/1", results, decision };
}

/** Machine-checkable exit-code semantics for the activation decision. */
export function activationExitCode(evaluation: CapabilityEvaluation): 0 | 1 | 2 {
  if (evaluation.decision === "BLOCKED") return 2;
  if (evaluation.decision === "DEGRADED") return 1;
  return 0;
}
