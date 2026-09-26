import type { EffectHistory } from "@relay/core";

/** Interpret recorded state only; never contact a provider or authorize replay. */
export function explainEffects(histories: EffectHistory[], malformedRows: number): string {
  const lines = ["Local journal snapshot only; this is not a check of current remote truth."];
  if (malformedRows > 0) lines.push(`WARNING: ${malformedRows} malformed rows in the sampled journal (event checks include other keys); evidence is incomplete.`);
  if (histories.length === 0) lines.push("No matching recorded effects. Absence is not permission to execute.");
  for (const { record: r, coverage } of histories) {
    lines.push(`${r.status} key=${JSON.stringify(r.key)} id=${JSON.stringify(r.id)} history=${coverage}`);
    if (coverage !== "observed") lines.push("  Transition history is incomplete or unavailable; do not infer recovery from it.");
    if (r.status === "UNKNOWN" || r.status === "SUBMITTED") {
      lines.push("  Outcome is unresolved: do not resubmit or switch operation IDs. Reconcile with the configured provider.");
      const actionId = r.kind.startsWith("mcp:") ? r.kind.slice(4) : "";
      const prefix = `${actionId}:`;
      if (/^[a-z0-9][a-z0-9-]*$/.test(actionId) && r.key.startsWith(prefix) && r.key.length > prefix.length) {
        lines.push(`  Recorded MCP identity suggests relay_reconcile_operation ${JSON.stringify({ actionId, operationId: r.key.slice(prefix.length) })}. Verify journal ownership and the same action/provider configuration first; this is an MCP tool, not a shell command.`);
      } else {
        lines.push("  No reliable MCP action mapping; use the owning provider's reconciliation procedure.");
      }
    } else if (r.status === "PREPARED") {
      lines.push("  Preparation is recorded, submission is not. Check the current owner and provider before continuing with the same identity.");
    } else if (r.status === "CONFIRMED") {
      lines.push("  Completion is recorded. Inspect existing results; do not repeat the operation.");
    } else {
      lines.push("  Failure is recorded. Review provider evidence and policy; FAILED alone does not authorize a retry.");
    }
  }
  return `${lines.join("\n")}\n`;
}
