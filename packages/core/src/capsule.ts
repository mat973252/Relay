/**
 * @relay/core — capsule manifest contract (M4).
 *
 * A capsule is an export FORMAT, not a runtime: it carries Relay-owned
 * durable facts (effect journal, artifact records + content), the
 * capability requirements, optional opaque adapter material, and migration
 * evidence. Callers must keep secret values out of those inputs. All paths
 * inside a capsule are relative POSIX paths; machine-specific absolute paths are forbidden
 * (T23).
 */

export interface CapsuleFileEntry {
  /** Relative POSIX path inside the capsule archive. */
  path: string;
  sha256: string;
  byteSize: number;
}

export interface CapsuleManifest {
  schema: "relay.capsule/1";
  relayVersion: string;
  createdAt: number;
  /** Source workspace identifier; portable (relative), never absolute. */
  workspace: string;
  counts: { effects: number; artifactRecords: number; artifactObjects: number };
  files: CapsuleFileEntry[];
  integrity: { algorithm: "sha256" };
}

export interface MigrationEvidence {
  schema: "relay.migration/1";
  direction: "export" | "import";
  at: number;
  counts: { effects: number; artifactRecords: number; artifactObjects: number };
}

export const CAPSULE_ROOT = "relay-capsule";

/** Strict validation used on both export (self-check) and import (gate). */
export function validateManifest(manifest: unknown): CapsuleManifest {
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("capsule manifest is not an object");
  }
  const m = manifest as Record<string, unknown>;
  if (m.schema !== "relay.capsule/1") throw new Error(`unsupported capsule schema: ${String(m.schema)}`);
  if (typeof m.relayVersion !== "string") throw new Error("manifest.relayVersion must be a string");
  if (typeof m.createdAt !== "number") throw new Error("manifest.createdAt must be a number");
  if (typeof m.workspace !== "string" || m.workspace.startsWith("/") || m.workspace.includes("\\")) {
    throw new Error("manifest.workspace must be a portable relative path");
  }
  if (!Array.isArray(m.files)) throw new Error("manifest.files must be an array");
  const seen = new Set<string>();
  for (const entry of m.files) {
    if (typeof entry !== "object" || entry === null) throw new Error("manifest.files entries must be objects");
    const f = entry as Record<string, unknown>;
    if (typeof f.path !== "string" || f.path.length === 0) throw new Error("manifest file path missing");
    if (f.path.startsWith("/") || f.path.includes("\\") || f.path.split("/").includes("..")) {
      throw new Error(`manifest file path is not portable: ${String(f.path)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) throw new Error(`manifest file hash invalid for ${String(f.path)}`);
    if (typeof f.byteSize !== "number" || f.byteSize < 0) throw new Error(`manifest file size invalid for ${String(f.path)}`);
    if (seen.has(f.path)) throw new Error(`duplicate manifest file path: ${String(f.path)}`);
    seen.add(f.path);
  }
  const counts = m.counts as Record<string, unknown> | undefined;
  if (
    typeof counts !== "object" ||
    counts === null ||
    typeof counts.effects !== "number" ||
    typeof counts.artifactRecords !== "number" ||
    typeof counts.artifactObjects !== "number"
  ) {
    throw new Error("manifest.counts invalid");
  }
  return manifest as CapsuleManifest;
}
