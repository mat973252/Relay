import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runLocalVariable, type VariableIntent } from "./github-variable-effect.js";

const [workspace, input, mode] = process.argv.slice(2);
if (!workspace || !input || !mode) throw new Error("missing synthetic fixture arguments");
const intent = JSON.parse(readFileSync(input, "utf8")) as VariableIntent;
const refused = join(workspace, "contender-refused");
const result = await runLocalVariable(workspace, intent, "synthetic-auth-must-not-persist", {
  crashPrepared: mode === "crash-prepared",
  ...(mode === "race" ? { afterAcquire: async () => {
    const deadline = performance.now() + 10000;
    while (!existsSync(refused)) {
      if (performance.now() >= deadline) throw new Error("contender did not reach the held lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } } : {}),
});
if (result.status === "locked") writeFileSync(refused, "refused-before-journal-open");
process.stdout.write(`${JSON.stringify(result)}\n`);
