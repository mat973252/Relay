/**
 * M5 deferred-migration E2E (T16 analog + roadmap gate):
 *   - provider submission count == 1
 *   - process restart count >= 1 (submit process exits; resume process is new)
 *   - migration count >= 1 (capsule A -> B, session file travels in adapter material)
 *   - remote job completes after target-side Pi resume
 *
 * Everything runs through public Pi APIs: createAgentSession + custom native
 * provider for submission, SessionManager.open for migrated-session
 * inspection, ModelRuntime.fetchDeferred for the resume itself.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { discoverDeferred } from "../src/index.js";
import { startJobServer } from "./fixtures/job-server.js";
import { exportCapsule, importCapsule } from "@relay/cli/capsule";

const CHILD = fileURLToPath(new URL("./fixtures/deferred-child.js", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "relay-m5-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function runChild(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("M5 deferred migration through Pi public APIs", () => {
  it("submits once, migrates via capsule, resumes on machine B", { timeout: 180_000 }, async () => {
    const server = await startJobServer(1_200);
    const machineA = join(tmp, "a");
    const machineB = join(tmp, "b");
    const sessionDirA = join(machineA, "sessions");

    try {
      // Machine A: real Pi AgentSession persists a deferred assistant message.
      const submitted = await runChild(["submit", machineA, sessionDirA, server.baseUrl]);
      assert.equal(
        submitted.status,
        0,
        `submit failed:\n${submitted.stderr}\n${submitted.stdout}`,
      );
      const submittedInfo = JSON.parse(submitted.stdout.trim().split("\n").pop() ?? "{}") as {
        sessionFile: string;
      };
      assert.equal(server.submissions(), 1, "submission count must be exactly 1 after submit");

      // Relay discovers the persisted deferred handle (documented format).
      const discovered = await discoverDeferred(sessionDirA);
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0]?.handle.id.startsWith("job-"), true);

      // Capsule migration carries the Pi session file as adapter material.
      const sessionBytes = readFileSync(submittedInfo.sessionFile);
      const sessionName = submittedInfo.sessionFile.split("/").pop() ?? "session.jsonl";
      const capsulePath = join(tmp, "m5-capsule.tar.gz");
      await exportCapsule({
        workspace: machineA,
        output: capsulePath,
        adapterContextPath: await (async () => {
          const ctxPath = join(machineA, "relay-adapter-context.json");
          const { writeFile } = await import("node:fs/promises");
          await writeFile(
            ctxPath,
            JSON.stringify({
              schema: "relay.adapter-deferred/1",
              deferred: discovered.map((d) => ({ sessionFile: sessionName, handle: d.handle })),
            }),
          );
          return ctxPath;
        })(),
        extraAdapterFiles: [{ path: `sessions/${sessionName}`, data: sessionBytes }],
      });
      await importCapsule({ capsule: capsulePath, workspace: machineB });

      const migratedSession = join(machineB, ".relay", "adapter", "sessions", sessionName);
      const migratedBytes = readFileSync(migratedSession);
      assert.ok(migratedBytes.equals(sessionBytes), "session file changed during migration");

      // Machine B: Pi opens the migrated session, then resumes via fetchDeferred.
      const resumed = await runChild(["resume", migratedSession, server.baseUrl]);
      assert.equal(resumed.status, 0, `resume failed:\n${resumed.stderr}\n${resumed.stdout}`);
      const resumeInfo = JSON.parse(resumed.stdout.trim().split("\n").pop() ?? "{}") as {
        stopReason: string;
        text: string;
        entries: number;
      };
      assert.equal(resumeInfo.stopReason, "stop");
      assert.match(resumeInfo.text, /job-\d+ finished: 42/);
      assert.ok(resumeInfo.entries >= 1, "migrated session should be inspectable");

      // Gate invariants: 1 submission, 2 processes, 1 migration, job completed.
      assert.equal(server.submissions(), 1, "deferred job was submitted more than once");
      assert.equal(server.completed(), true, "remote job did not complete after resume");
    } finally {
      await server.stop();
    }
  });
});
