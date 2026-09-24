/**
 * The ONLY module in @relay/mcp permitted to read `process.env`.
 *
 * Same contract as packages/cli/src/env.ts (enforced by the boundary test):
 * values flow exclusively into outgoing HTTP headers for configured action
 * endpoints and must never appear in tool results, logs, or serialized state.
 */

/** Header value for configured action secretHeaders. In-flight use only. */
export function envHeaderValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
