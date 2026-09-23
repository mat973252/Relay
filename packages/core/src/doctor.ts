/**
 * @relay/core — Relay capability doctor domain.
 *
 * Pure domain only: no filesystem, process, network, or Pi assumptions.
 * All environment interaction is injected as probes; results are derived,
 * never narrated (no timestamps, progress claims, or recomputable prose).
 */

export type CheckStatus = "ok" | "warn" | "fail";

/** Result of a single injected environment probe. */
export interface ProbeOutcome {
  status: CheckStatus;
  detail: string;
}

/** A doctor check as rendered into reports. */
export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** Operator-facing context; values are supplied by the caller, never sniffed here. */
export interface DoctorContext {
  cwd: string;
}

export interface DoctorResult {
  schema: "relay.doctor/1";
  relayVersion: string;
  context: DoctorContext;
  checks: DoctorCheck[];
  summary: CheckStatus;
}

/** Probe specification: identity/label plus the injected probe function. */
export interface DoctorProbeSpec {
  id: string;
  label: string;
  run: () => Promise<ProbeOutcome>;
}

export interface RunDoctorInput {
  relayVersion: string;
  context: DoctorContext;
  probes: DoctorProbeSpec[];
}

const STATUS_SEVERITY: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }
  return worst;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Deterministic: the same input (including injected probe outcomes) always
 * yields the same result. Checks are ordered by id; a throwing probe becomes
 * a `fail` check instead of aborting the doctor run.
 */
export async function runDoctor(input: RunDoctorInput): Promise<DoctorResult> {
  const seen = new Set<string>();
  const checks: DoctorCheck[] = [];
  for (const probe of input.probes) {
    if (seen.has(probe.id)) {
      throw new Error(`duplicate doctor probe id: ${probe.id}`);
    }
    seen.add(probe.id);
    let outcome: ProbeOutcome;
    try {
      outcome = await probe.run();
    } catch (err) {
      outcome = { status: "fail", detail: `probe error: ${errorMessage(err)}` };
    }
    checks.push({
      id: probe.id,
      label: probe.label,
      status: outcome.status,
      detail: outcome.detail,
    });
  }
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: "relay.doctor/1",
    relayVersion: input.relayVersion,
    context: { cwd: input.context.cwd },
    checks,
    summary: worstStatus(checks.map((check) => check.status)),
  };
}

export type DoctorExitCode = 0 | 1 | 2;

/** Machine-checkable semantics: 0 = ok, 1 = degraded (warn), 2 = blocked (fail). */
export function doctorExitCode(result: DoctorResult): DoctorExitCode {
  if (result.summary === "fail") return 2;
  if (result.summary === "warn") return 1;
  return 0;
}
