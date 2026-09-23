import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RELAY_VERSION } from "../src/version.js";

describe("relay version", () => {
  it("RELAY_VERSION matches packages/core/package.json", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    assert.equal(pkg.version, RELAY_VERSION);
  });
});
