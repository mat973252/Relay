/** Read-only source example; intentionally has no submit operation. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Input { repository: string; repositoryId: number; name: string }
type Transport = (url: string, options: RequestInit) => Promise<Response>;
const API = "https://api.github.com";
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid response");
  return value as Record<string, unknown>;
}

export async function preflight(input: Input, token: string | undefined, transport: Transport = fetch) {
  if (!/^[A-Za-z0-9-]+\/[\w.-]+$/.test(input.repository) || [".", ".."].includes(input.repository.split("/")[1] ?? "") || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !/^RELAY_PROBE_[A-Z0-9_]{1,100}$/.test(input.name)) {
    throw new Error("invalid preflight arguments");
  }
  const report = {
    schema: "relay.github-preflight/1", checkedAt: new Date().toISOString(), repository: input.repository, repositoryId: input.repositoryId, name: input.name,
    identity: "unverified", absence: "unverified", variablesRead: "unverified",
    variablesWrite: "unverified", atomicSnapshot: false, postAuthorized: false, status: "blocked", reasons: [] as string[],
  };
  if (!token) { report.reasons.push("token_missing"); return report; }
  async function get(path: string) {
    const response = await transport(`${API}${path}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
    });
    if (response.status !== 200) throw new Error("unverified HTTP response");
    return object(await response.json());
  }
  try {
    const repository = await get(`/repos/${input.repository}`);
    if (repository.id !== input.repositoryId || typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== input.repository.toLowerCase()) {
      report.reasons.push("repository_identity_mismatch"); return report;
    }
    report.identity = "matched";
    const names = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const body = await get(`/repos/${input.repository}/actions/variables?per_page=30&page=${page}`);
      if (typeof body.total_count !== "number" || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || !Array.isArray(body.variables) || body.variables.length > 30) throw new Error("invalid list");
      if (total !== undefined && total !== body.total_count) throw new Error("list changed");
      total = body.total_count;
      for (const variable of body.variables) {
        const name = object(variable).name;
        if (typeof name !== "string" || !name || names.has(name.toUpperCase())) throw new Error("invalid or unstable list");
        names.add(name.toUpperCase());
      }
      report.variablesRead = "observed";
      if (names.has(input.name)) { report.absence = "name_exists"; report.reasons.push("name_collision"); return report; }
      if (names.size === total) { report.absence = "not_seen_in_enumeration"; report.status = "enumeration_complete"; return report; }
      if (names.size > total || body.variables.length < 30) throw new Error("incomplete list");
    }
    report.reasons.push("pagination_limit");
  } catch {
    // Do not echo API bodies, existing variable values, tokens, or raw errors.
    report.reasons.push("query_unverified");
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { repo: { type: "string" }, "repo-id": { type: "string" }, name: { type: "string" } } });
    const report = await preflight({ repository: values.repo ?? "", repositoryId: Number(values["repo-id"]), name: values.name ?? "" }, process.env.RELAY_GITHUB_TOKEN);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "enumeration_complete" ? 0 : 2;
  } catch {
    process.stderr.write("Expected --repo owner/name --repo-id positive-integer --name RELAY_PROBE_UNIQUE\n");
    process.exitCode = 64;
  }
}
