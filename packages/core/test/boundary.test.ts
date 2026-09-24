/**
 * Workspace boundary invariants, mechanized:
 *
 * 1. @relay/core has no Pi dependency (and no runtime dependencies at all).
 * 2. @relay/adapter-pi is the ONLY package allowed to reference Pi packages,
 *    and it actually does (guards against a vacuous pass).
 * 3. No package source reads process.env (doctor output cannot leak
 *    arbitrary environment values because nothing ever reads them).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const packagesDir = fileURLToPath(new URL("../../../", import.meta.url));

const PI_PACKAGE_PATTERN =
  /@earendil-works\/pi-(coding-agent|ai|tui|agent-core|protocol|client|server)/;

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function listPackageNames(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function readPkgJson(pkgName: string): PkgJson {
  const pkgPath = join(packagesDir, pkgName, "package.json");
  assert.ok(statSync(pkgPath, { throwIfNoEntry: false }) !== undefined, `missing ${pkgPath}`);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PkgJson;
}

function dependencyKeys(pkg: PkgJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

function srcFiles(pkgName: string): string[] {
  const srcDir = join(packagesDir, pkgName, "src");
  if (statSync(srcDir, { throwIfNoEntry: false }) === undefined) return [];
  return listTsFiles(srcDir);
}

describe("workspace boundary invariants", () => {
  const packages = listPackageNames();

  it("packages/core, storage-sqlite, artifact-fs, cli exist", () => {
    for (const expected of ["adapter-pi", "artifact-fs", "cli", "core", "storage-sqlite"]) {
      assert.ok(packages.includes(expected), `missing package ${expected}`);
    }
  });

  it("only adapter-pi declares Pi package dependencies", () => {
    for (const pkgName of packages) {
      const pkg = readPkgJson(pkgName);
      const piDeps = dependencyKeys(pkg).filter((key) => PI_PACKAGE_PATTERN.test(key));
      if (pkgName === "adapter-pi") {
        assert.ok(piDeps.length > 0, "adapter-pi must declare a Pi package dependency");
      } else {
        assert.deepEqual(piDeps, [], `${pkgName} must not declare Pi package dependencies`);
      }
    }
  });

  it("only adapter-pi source references Pi packages", () => {
    for (const pkgName of packages) {
      for (const file of srcFiles(pkgName)) {
        const content = readFileSync(file, "utf8");
        if (pkgName === "adapter-pi") continue; // allowed
        assert.ok(
          !PI_PACKAGE_PATTERN.test(content),
          `${file} references a Pi package; only adapter-pi may do that`,
        );
      }
    }
  });

  it("adapter-pi actually uses the public Pi extension API", () => {
    const references = srcFiles("adapter-pi")
      .map((file) => readFileSync(file, "utf8"))
      .filter((content) => PI_PACKAGE_PATTERN.test(content));
    assert.ok(references.length > 0, "adapter-pi source must reference the Pi public API");
  });

  it("core has zero runtime dependencies", () => {
    const pkg = readPkgJson("core");
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  it("no package source reads process.env (sanctioned readers: cli/src/env.ts and mcp/src/env.ts only)", () => {
    const sanctioned = [join("cli", "src", "env.ts"), join("mcp", "src", "env.ts")];
    for (const pkgName of packages) {
      for (const file of srcFiles(pkgName)) {
        const content = readFileSync(file, "utf8");
        const relative = file.slice(packagesDir.length).split("\\").join("/");
        if (sanctioned.some((s) => relative === s)) {
          assert.ok(
            content.includes("process.env"),
            `${relative} is a sanctioned env reader; keep it reading env here`,
          );
          continue;
        }
        assert.ok(!content.includes("process.env"), `${file} must not read process.env`);
      }
    }
  });
});
