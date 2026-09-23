import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { probeArtifactRoot } from "../src/index.js";

let tmp = "";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-artifact-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("probeArtifactRoot", () => {
  it("creates the root, verifies read/write, and cleans the probe file", async () => {
    const root = join(tmp, "relay", "artifacts");
    const outcome = await probeArtifactRoot({ root });
    assert.equal(outcome.status, "ok");
    assert.match(outcome.detail, /artifact root read\/write verified/);
    assert.ok(existsSync(root), "artifact root should exist");
    assert.ok(!existsSync(join(root, "relay-probe.txt")), "probe file should be removed");
  });

  it("reports fail when the root path is an existing file", async () => {
    const root = join(tmp, "blocker.txt");
    writeFileSync(root, "not a directory", "utf8");
    const outcome = await probeArtifactRoot({ root });
    assert.equal(outcome.status, "fail");
    assert.ok(outcome.detail.length > 0);
  });
});
