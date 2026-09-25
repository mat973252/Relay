/**
 * Fence-gap watcher child: busy-polls the SUCCESSION state
 * (fence file + lock file) and reports the first instant the invariant is
 * broken: the fence is ABSENT while the lock still carries the exact stale
 * body (an unprotected succession). Releases the trigger file at that
 * moment so a third process can attempt acquisition exactly inside the gap.
 *
 * Usage: watch-fence-child.js <lockFile> <fenceFile> <stalePid> <staleHostname>
 *                             <staleStartedAt> <triggerFile> <stopFile> <reportFile>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , lockFile, fenceFile, rawPid, rawHostname, rawStartedAt, triggerFile, stopFile, reportFile] = process.argv;
if (
  lockFile === undefined || fenceFile === undefined || rawPid === undefined || rawHostname === undefined ||
  rawStartedAt === undefined || triggerFile === undefined || stopFile === undefined || reportFile === undefined
) {
  process.stderr.write(
    "usage: watch-fence-child.js <lockFile> <fenceFile> <stalePid> <staleHostname> <staleStartedAt> <triggerFile> <stopFile> <reportFile>\n",
  );
  process.exit(64);
}
const stale = { pid: Number(rawPid), hostname: rawHostname!, startedAt: Number(rawStartedAt) };

function lockIsStale(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(lockFile!, "utf8")) as Record<string, unknown>;
    return (
      parsed.pid === stale.pid && parsed.hostname === stale.hostname && parsed.startedAt === stale.startedAt
    );
  } catch {
    return false;
  }
}

let gapCount = 0;
let triggered = false;
const deadline = Date.now() + 30_000;
while (!existsSync(stopFile) && Date.now() < deadline) {
  for (let i = 0; i < 100; i += 1) {
    if (!existsSync(fenceFile) && existsSync(lockFile) && lockIsStale()) {
      gapCount += 1;
      if (!triggered) {
        writeFileSync(triggerFile, "go");
        triggered = true;
      }
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
writeFileSync(reportFile, `${JSON.stringify({ gapCount, triggered })}\n`);
process.exit(0);
