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
import { ArtifactStore } from "@relay/artifact-fs";

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

  it("artifacts lists records written through the store", async () => {
    const artifactsRoot = join(tmp, "arts-cli");
    const store = await ArtifactStore.open({ root: artifactsRoot });
    const source = await store.write({
      content: "src",
      mediaType: "text/plain",
      producer: { type: "human", id: "author-1" },
    });
    const report = await store.write({
      content: "report",
      mediaType: "text/markdown",
      producer: { type: "tool", id: "writer" },
      parents: [source.id],
    });

    const listing = runCli(["artifacts", "--artifacts", artifactsRoot]);
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout ?? "", /artifact:\/\/sha256\//);
    assert.match(listing.stdout ?? "", /parents=1/);

    const json = runCli(["artifacts", "--json", "--artifacts", artifactsRoot]);
    assert.equal(json.status, 0);
    const parsed = JSON.parse((json.stdout ?? "").trim()) as {
      schema?: string;
      artifacts?: { artifactId: string }[];
    };
    assert.equal(parsed.schema, "relay.artifacts/1");
    assert.equal(parsed.artifacts?.length, 2);

    const lineage = runCli(["lineage", report.artifactId, "--artifacts", artifactsRoot]);
    assert.equal(lineage.status, 0, lineage.stderr);
    const out = lineage.stdout ?? "";
    assert.ok(out.indexOf(report.artifactId) < out.indexOf(source.artifactId), "root before parent");

    const lineageJson = runCli(["lineage", report.id, "--json", "--artifacts", artifactsRoot]);
    assert.equal(lineageJson.status, 0);
    const tree = JSON.parse((lineageJson.stdout ?? "").trim()) as {
      schema?: string;
      root?: { record?: { id?: string }; parents?: { record?: { id?: string } }[] };
      problems?: string[];
    };
    assert.equal(tree.schema, "relay.lineage/1");
    assert.equal(tree.root?.record?.id, report.id);
    assert.equal(tree.root?.parents?.[0]?.record?.id, source.id);
    assert.deepEqual(tree.problems, []);

    assert.equal(runCli(["lineage", "artifact://sha256/" + "0".repeat(64), "--artifacts", artifactsRoot]).status, 66);
    assert.equal(runCli(["lineage", "--artifacts", artifactsRoot]).status, 64);
  });
});
