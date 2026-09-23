/**
 * M3 CLI integration: relay.capabilities.yaml parsing, real probes through
 * `relay doctor`, and secret isolation (T14: secret values never appear in
 * any output even though probes use them in-flight).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { evaluateCapabilitiesFile, loadCapabilitiesFile } from "../src/capabilities.js";

const cliJs = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET_VALUE = "relay-capability-fake-secret-token-9f3a";

const tmp = mkdtempSync(join(tmpdir(), "relay-capabilities-"));
process.env.RELAY_TEST_CAP_TOKEN = SECRET_VALUE;
after(() => rmSync(tmp, { recursive: true, force: true }));

function runDoctor(cwd: string, extra: string[] = []) {
  return spawnSync(process.execPath, [cliJs, "doctor", "--storage", join(cwd, "s.db"), "--artifacts", join(cwd, "a"), ...extra], {
    encoding: "utf8",
    cwd,
    timeout: 60_000,
    env: { ...process.env, RELAY_TEST_CAP_TOKEN: SECRET_VALUE },
  });
}

describe("relay.capabilities.yaml loading", () => {
  it("parses schema relay.capabilities/1 into specs", async () => {
    const path = join(tmp, "ok.yaml");
    writeFileSync(
      path,
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: pi-cli",
        "    label: Pi CLI",
        "    required: true",
        "    check:",
        "      kind: command-on-path",
        "      command: pi",
        "  - id: backup-store",
        "    required: false",
        "    check:",
        "      kind: node-module",
        "      module: node:sqlite",
      ].join("\n"),
    );
    const file = await loadCapabilitiesFile(path);
    assert.equal(file.specs.length, 2);
    assert.equal(file.specs[0]?.required, true);
    assert.equal(file.specs[1]?.check.kind, "node-module");
  });

  it("rejects unknown schema and missing checks", async () => {
    const bad1 = join(tmp, "bad1.yaml");
    writeFileSync(bad1, "schema: relay.capabilities/9\ncapabilities: []");
    await assert.rejects(() => loadCapabilitiesFile(bad1), /unsupported schema/);
    const bad2 = join(tmp, "bad2.yaml");
    writeFileSync(bad2, "schema: relay.capabilities/1\ncapabilities:\n  - id: x\n    required: true");
    await assert.rejects(() => loadCapabilitiesFile(bad2), /no valid check/);
  });
});

describe("relay doctor capability evaluation", () => {
  it("optional missing capability degrades but runs (T03): exit 1", () => {
    const cwd = mkdtempSync(join(tmp, "t03-"));
    writeFileSync(
      join(cwd, "relay.capabilities.yaml"),
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: pi-cli",
        "    required: true",
        "    check: { kind: command-on-path, command: pi }",
        "  - id: never-exists-xyz",
        "    required: false",
        "    check: { kind: command-on-path, command: definitely-not-a-real-command-xyz }",
      ].join("\n"),
    );
    const result = runDoctor(cwd);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, /\[MISSING\/optional\] never-exists-xyz/);
    assert.match(output, /activation: DEGRADED/);
    assert.ok(!output.includes(SECRET_VALUE));
  });

  it("required missing capability blocks activation (T04): exit 2", () => {
    const cwd = mkdtempSync(join(tmp, "t04-"));
    writeFileSync(
      join(cwd, "relay.capabilities.yaml"),
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: must-exist",
        "    required: true",
        "    check: { kind: command-on-path, command: definitely-not-a-real-command-xyz }",
      ].join("\n"),
    );
    const result = runDoctor(cwd);
    assert.equal(result.status, 2);
    assert.match(result.stdout ?? "", /activation: BLOCKED/);
  });

  it("required secret reference present -> READY; the value never leaks (T14)", () => {
    const cwd = mkdtempSync(join(tmp, "t14-env-"));
    writeFileSync(
      join(cwd, "relay.capabilities.yaml"),
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: provider-token",
        "    label: Provider token",
        "    required: true",
        "    check: { kind: env-ref, env: RELAY_TEST_CAP_TOKEN }",
      ].join("\n"),
    );
    const result = runDoctor(cwd, ["--json"]);
    assert.equal(result.status, 0, result.stdout);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, /"decision":"READY"/);
    assert.match(output, /RELAY_TEST_CAP_TOKEN is set/);
    assert.ok(!output.includes(SECRET_VALUE), "secret value leaked into doctor output");
  });

  it("required secret reference absent -> BLOCKED without revealing anything", () => {
    const cwd = mkdtempSync(join(tmp, "t14-env-absent-"));
    writeFileSync(
      join(cwd, "relay.capabilities.yaml"),
      [
        "schema: relay.capabilities/1",
        "capabilities:",
        "  - id: provider-token",
        "    required: true",
        "    check: { kind: env-ref, env: RELAY_TEST_CAP_TOKEN_UNSET }",
      ].join("\n"),
    );
    const result = runDoctor(cwd);
    assert.equal(result.status, 2);
    assert.match(result.stdout ?? "", /\[DENIED\/required\]/);
  });

  it("http check sends secret header in-flight and never prints it", async () => {
    let sawSecretHeader = false;
    const server = createServer((req, res) => {
      if (req.headers.authorization === SECRET_VALUE) sawSecretHeader = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"ok\":true}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/health`;
    try {
      const cwd = mkdtempSync(join(tmp, "t14-http-"));
      writeFileSync(
        join(cwd, "relay.capabilities.yaml"),
        [
          "schema: relay.capabilities/1",
          "capabilities:",
          "  - id: provider-http",
          "    required: true",
          "    check:",
          "      kind: http",
          `      url: ${url}`,
          "      secretHeaders:",
          "        authorization: RELAY_TEST_CAP_TOKEN",
        ].join("\n"),
      );
      const { evaluation } = await evaluateCapabilitiesFile({ path: join(cwd, "relay.capabilities.yaml") });
      assert.equal(evaluation.decision, "READY");
      assert.ok(sawSecretHeader, "probe did not send the secret header");
      const serialized = JSON.stringify(evaluation);
      assert.ok(!serialized.includes(SECRET_VALUE), "secret value leaked into evaluation");
    } finally {
      server.close();
    }
  });

  it("invalid capabilities file blocks with exit 2", () => {
    const cwd = mkdtempSync(join(tmp, "invalid-"));
    writeFileSync(join(cwd, "relay.capabilities.yaml"), "capabilities: not-a-list");
    const result = runDoctor(cwd);
    assert.equal(result.status, 2);
    assert.match(result.stdout ?? "", /invalid —/);
  });
});
