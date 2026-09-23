/**
 * CLI integration tests: spawn the compiled CLI exactly like an operator
 * would, assert exit codes, output shape, and that secret environment values
 * never appear in output.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";

const cliJs = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET_VALUE = "relay-cli-fake-secret-value";

let tmp = "";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-cli-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string = tmp) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, RELAY_TEST_CLI_SECRET: SECRET_VALUE },
  });
}

describe("relay cli", () => {
  it("doctor exits 0 with a human report and does not leak environment values", () => {
    const result = runCli(["doctor", "--storage", join(tmp, "s", "storage.db"), "--artifacts", join(tmp, "a")]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      assert.fail(`relay doctor exited ${String(result.status)}:\n${output}`);
    }
    assert.match(result.stdout ?? "", /^relay doctor — relay v/m);
    assert.match(result.stdout ?? "", /^\[ok\] Pi CLI \(pi\): pi \d+\.\d+\.\d+ on PATH$/m);
    assert.match(result.stdout ?? "", /^\[ok\] SQLite storage \(storage\): /m);
    assert.match(result.stdout ?? "", /^\[ok\] Artifact root \(artifacts\): /m);
    assert.match(result.stdout ?? "", /^summary: ok$/m);
    assert.match(result.stdout ?? "", /^exit code: 0$/m);
    assert.ok(!output.includes(SECRET_VALUE), "CLI output leaked an environment value");
  });

  it("doctor --json emits the stable doctor schema", () => {
    const result = runCli(["doctor", "--json", "--storage", join(tmp, "s2", "storage.db"), "--artifacts", join(tmp, "a2")]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse((result.stdout ?? "").trim()) as {
      schema?: string;
      summary?: string;
      checks?: { id: string; status: string }[];
    };
    assert.equal(parsed.schema, "relay.doctor/1");
    assert.equal(parsed.summary, "ok");
    assert.deepEqual(
      (parsed.checks ?? []).map((check) => check.id),
      ["artifacts", "pi", "storage"],
    );
    assert.ok(!`${result.stdout ?? ""}${result.stderr ?? ""}`.includes(SECRET_VALUE));
  });

  it("doctor exits 2 when a required capability fails", () => {
    const junk = join(tmp, "junk.db");
    writeFileSync(junk, "not a sqlite database", "utf8");
    const result = runCli(["doctor", "--storage", junk, "--artifacts", join(tmp, "a3")]);
    assert.equal(result.status, 2);
    assert.match(result.stdout ?? "", /^summary: fail$/m);
    assert.match(result.stdout ?? "", /^\[fail\] SQLite storage \(storage\): /m);
  });

  it("unknown commands and no arguments exit 64", () => {
    assert.equal(runCli(["bogus"]).status, 64);
    assert.equal(runCli([]).status, 64);
    assert.equal(runCli(["doctor", "--nope"]).status, 64);
  });

  it("--help exits 0", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /usage:/);
  });
});
