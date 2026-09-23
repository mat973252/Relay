import type { DoctorResult } from "./doctor.js";
import { doctorExitCode } from "./doctor.js";

/**
 * Deterministic human-facing rendering.
 *
 * Only explicitly structured DoctorResult fields are rendered, so doctor
 * output can never contain values (e.g. environment secrets) that were not
 * deliberately placed into a check detail by a Relay-owned probe.
 */
export function formatDoctorReport(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`relay doctor — relay v${result.relayVersion}`);
  lines.push(`cwd: ${result.context.cwd}`);
  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.label} (${check.id}): ${check.detail}`);
  }
  lines.push(`summary: ${result.summary}`);
  lines.push(`exit code: ${doctorExitCode(result)}`);
  return lines.join("\n");
}

/** Deterministic machine-readable rendering (stable key order). */
export function formatDoctorJson(result: DoctorResult): string {
  return `${JSON.stringify(result)}\n`;
}
