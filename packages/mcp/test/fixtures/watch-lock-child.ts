/**
 * Lock-window watcher child: busy-polls the lock file's existence, counts
 * every instant it is ABSENT, and releases a trigger file on the FIRST
 * absence (letting a third process attempt acquisition exactly inside the
 * window). Writes a JSON report and exits when the stop file appears.
 *
 * Usage: watch-lock-child.js <lockFile> <triggerFile> <stopFile> <reportFile>
 */
import { existsSync, writeFileSync } from "node:fs";

const [, , lockFile, triggerFile, stopFile, reportFile] = process.argv;
if (lockFile === undefined || triggerFile === undefined || stopFile === undefined || reportFile === undefined) {
  process.stderr.write("usage: watch-lock-child.js <lockFile> <triggerFile> <stopFile> <reportFile>\n");
  process.exit(64);
}

let absentCount = 0;
let triggered = false;
const deadline = Date.now() + 30_000;
while (!existsSync(stopFile) && Date.now() < deadline) {
  for (let i = 0; i < 100; i += 1) {
    if (!existsSync(lockFile)) {
      absentCount += 1;
      if (!triggered) {
        writeFileSync(triggerFile, "go");
        triggered = true;
      }
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
writeFileSync(reportFile, `${JSON.stringify({ absentCount, triggered })}\n`);
process.exit(0);
