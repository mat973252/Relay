/**
 * Tests for the Relay Pi adapter.
 *
 * 1. Command registration through the public registerCommand API.
 * 2. Handler executes real probes against ctx.cwd (print mode → stdout).
 * 3. Deterministic repeated output.
 * 4. TUI mode reports through ctx.ui.notify.
 * 5. Real integration: the installed Pi CLI loads this extension via its
 *    public `-e` mechanism and executes `/relay:doctor` through
 *    `pi -p "/relay:doctor"` (extension commands are dispatched by
 *    AgentSession.prompt without an LLM call).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRelayExtension, RELAY_DOCTOR_COMMAND } from "../src/index.js";

interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface MockCtx {
  mode: "print" | "tui";
  cwd: string;
  ui: { notify: (message: string, type?: string | undefined) => void };
}

function registerExtension(output?: { write(chunk: string): void }): RegisteredCommand[] {
  const registered: RegisteredCommand[] = [];
  const fakePi = {
    registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
      registered.push({ name, ...options });
    },
  };
  createRelayExtension(output === undefined ? {} : { output })(fakePi as unknown as ExtensionAPI);
  return registered;
}

function makeMockCtx(mode: "print" | "tui", cwd: string): MockCtx {
  return {
    mode,
    cwd,
    ui: { notify: () => assert.fail("notify should not be called in this test") },
  };
}

function makeCollector(): { output: { write(chunk: string): void }; text: () => string } {
  let buffered = "";
  return {
    output: { write: (chunk: string) => (buffered += chunk) },
    text: () => buffered,
  };
}

describe("relay pi extension (public API unit)", () => {
  it(`registers "/${RELAY_DOCTOR_COMMAND}" via registerCommand`, () => {
    const registered = registerExtension();
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.name, "relay:doctor");
    assert.equal(typeof registered[0]?.description, "string");
    assert.equal(typeof registered[0]?.handler, "function");
  });

  it("handler runs real probes against ctx.cwd and writes the report to the injected output in print mode", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-adapter-"));
    try {
      const collector = makeCollector();
      const [command] = registerExtension(collector.output);
      assert.ok(command !== undefined);
      await command.handler("", makeMockCtx("print", tmp));
      const output = collector.text();
      assert.match(output, /^relay doctor — relay v/m);
      assert.match(output, /^cwd: /m);
      assert.match(output, /^\[ok\] SQLite storage \(storage\): /m);
      assert.match(output, /^\[ok\] Artifact root \(artifacts\): /m);
      assert.match(output, /^summary: ok$/m);
      assert.ok(existsSync(join(tmp, ".relay", "storage.db")), "storage probe file created");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handler output is deterministic for the same working directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-adapter-"));
    try {
      const first = makeCollector();
      const second = makeCollector();
      const [commandA] = registerExtension(first.output);
      const [commandB] = registerExtension(second.output);
      assert.ok(commandA !== undefined && commandB !== undefined);
      await commandA.handler("", makeMockCtx("print", tmp));
      await commandB.handler("", makeMockCtx("print", tmp));
      assert.equal(first.text(), second.text());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handler reports through ctx.ui.notify outside print mode", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-adapter-"));
    try {
      const notifications: { message: string; type: string | undefined }[] = [];
      const ctx = {
        mode: "tui",
        cwd: tmp,
        ui: {
          notify: (message: string, type?: string | undefined) => notifications.push({ message, type }),
        },
      } satisfies MockCtx;
      const [command] = registerExtension();
      assert.ok(command !== undefined);
      await command.handler("", ctx);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]?.message ?? "", /^relay doctor — relay v/m);
      assert.equal(notifications[0]?.type, "info");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("relay pi extension (real Pi CLI integration)", () => {
  const entryPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const SECRET_VALUE = "relay-integration-fake-secret-value";

  /**
   * Resolve the installed Pi CLI bundle from the workspace dependency so the
   * test never depends on `pi` being on PATH or on shell quoting rules.
   */
  function piCliPath(): string {
    const cli = fileURLToPath(
      new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url),
    );
    if (!existsSync(cli)) {
      throw new Error(`pi CLI bundle not found at ${cli}`);
    }
    return cli;
  }

  function runPi(cwd: string) {
    return spawnSync(process.execPath, [piCliPath(), "-p", "/relay:doctor", "-e", entryPath], {
      encoding: "utf8",
      cwd,
      timeout: 180_000,
      env: { ...process.env, RELAY_TEST_INTEGRATION_SECRET: SECRET_VALUE },
    });
  }

  it("loads via pi -e and executes /relay:doctor without an LLM call", { timeout: 200_000 }, () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-pi-e2e-"));
    try {
      const result = runPi(tmp);
      assert.equal(
        result.error ?? null,
        null,
        `failed to spawn pi: ${String(result.error ?? "unknown")}`,
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.status !== 0) {
        assert.fail(`pi exited ${String(result.status)}:\n${output}`);
      }
      // Pi routes print-mode output to stdout when attached to a terminal
      // but to stderr when spawned with piped stdio; accept either stream.
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.match(combined, /^relay doctor — relay v/m);
      assert.match(combined, /^\[ok\] SQLite storage \(storage\): /m);
      assert.match(combined, /^summary: ok$/m);
      // Secret environment values must never leak into doctor output.
      assert.ok(!combined.includes(SECRET_VALUE), "doctor output leaked an environment value");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
