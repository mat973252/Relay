/**
 * M5 child fixture: proves deferred submission/resume across processes.
 *
 * usage:
 *   deferred-child.js submit <cwd> <sessionDir> <jobBaseUrl>
 *     -> creates a REAL Pi AgentSession with the mock deferred provider,
 *        prompts, and lets the session persist a deferred assistant message.
 *        Prints {sessionFile, handle}.
 *
 *   deferred-child.js resume <sessionFile> <jobBaseUrl>
 *     -> opens the migrated session file with Pi's SessionManager (proves
 *        inspection after migration), then resumes the deferred response
 *        through Pi's ModelRuntime.fetchDeferred. Prints {stopReason, text}.
 */
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createMockDeferredProvider,
  mockDeferredModel,
} from "../../src/index.js";

const mode = process.argv[2];
const jobBaseUrl = process.argv[process.argv.length - 1] ?? "";

function fail(message: string): never {
  process.stderr.write(`deferred-child: ${message}\n`);
  process.exit(64);
}

if (jobBaseUrl === "" || mode === undefined) fail("usage: deferred-child.js submit <cwd> <sessionDir> <url> | resume <sessionFile> <url>");

const provider = createMockDeferredProvider({ baseUrl: jobBaseUrl });
const model = mockDeferredModel();

if (mode === "submit") {
  const cwd = process.argv[3] ?? fail("submit requires <cwd>");
  const sessionDir = process.argv[4] ?? fail("submit requires <sessionDir>");
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider);
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    model,
    modelRuntime,
    sessionManager,
  });
  await session.prompt("Submit the long-running job and defer.");
  const sessionId = (sessionManager as unknown as { sessionId: string }).sessionId;
  const state = (sessionManager as unknown as { sessionFile?: string }).sessionFile;
  const sessionFile = state ?? join(
    sessionDir,
    (await readdir(sessionDir)).find((name) => name.endsWith(".jsonl")) ?? fail("no session file found"),
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, sessionId, sessionFile, model: model.id })}\n`,
  );
  process.exit(0);
}

if (mode === "resume") {
  const sessionFile = process.argv[3] ?? fail("resume requires <sessionFile>");
  // Inspection after migration: Pi's own SessionManager opens the file.
  const sessionManager = SessionManager.open(sessionFile);
  const entries = (sessionManager as unknown as {
    getEntries?: () => unknown[];
  }).getEntries?.() ?? [];
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider);

  // Find the deferred handle in the migrated session (documented format).
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(sessionFile, "utf8");
  let handle: { provider: string; modelId: string; api: string; id: string } | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { message?: { stopReason?: string; deferred?: unknown } };
      if (parsed.message?.stopReason === "deferred") {
        handle = parsed.message.deferred as typeof handle;
        break;
      }
    } catch {
      // skip malformed lines
    }
  }
  if (handle === undefined) fail(`no deferred handle found in ${sessionFile}`);

  // M6 chaos seam: death immediately before Pi resume.
  if (process.env.RELAY_TEST_CRASH === "before-fetch") {
    process.kill(process.pid, "SIGKILL");
  }

  // Resume through Pi's public deferred API (poll until complete).
  let message: { stopReason?: string; content?: { type: string; text?: string }[] } = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await modelRuntime.fetchDeferred(model, {
      provider: handle.provider,
      modelId: handle.modelId,
      api: handle.api,
      id: handle.id,
    });
    if (result.stopReason === "stop") {
      message = result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // M6 chaos seam: death immediately after the first successful resume.
  if (process.env.RELAY_TEST_CRASH === "after-fetch") {
    process.kill(process.pid, "SIGKILL");
  }
  const text = message.content?.map((part) => part.text ?? "").join("") ?? "";
  process.stdout.write(
    `${JSON.stringify({ ok: message.stopReason === "stop", stopReason: message.stopReason, text, entries: entries.length })}\n`,
  );
  // Let Pi's native async handles finish closing before terminating on Windows.
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(message.stopReason === "stop" ? 0 : 3);
}

fail(`unknown mode: ${mode}`);
