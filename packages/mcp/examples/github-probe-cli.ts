/** Explicit local plan/execute/reconcile entry point; not included in published files. */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hashRequest } from "@relay/core";
import { createProbePlan, runProbe } from "./github-probe.js";

try {
  const { values } = parseArgs({ options: {
    mode: { type: "string" }, repo: { type: "string" }, "repo-id": { type: "string" },
    workspace: { type: "string" }, plan: { type: "string" }, "approve-plan-hash": { type: "string" },
  } });
  if (values.mode === "plan") {
    const plan = await createProbePlan({ repository: values.repo ?? "", repositoryId: Number(values["repo-id"]), workspace: values.workspace ?? "" });
    const file = join(plan.workspace, "github-probe-plan.json");
    await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: "planned", planFile: file, planHash: hashRequest(plan), plan, postAuthorized: false }, null, 2)}\n`);
  } else {
    if (!["execute", "reconcile"].includes(values.mode ?? "") || !values.plan || (await stat(values.plan)).size > 16384) throw new Error("invalid arguments");
    const plan: unknown = JSON.parse(await readFile(values.plan, "utf8"));
    const result = await runProbe(plan, { mode: values.mode as "execute" | "reconcile", token: process.env.RELAY_GITHUB_TOKEN, approvedPlanHash: values["approve-plan-hash"] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "confirmed" ? 0 : 2;
  }
} catch {
  process.stderr.write("Probe arguments, plan file, or workspace invalid. No raw error details are emitted.\n");
  process.exitCode = 64;
}
