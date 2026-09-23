/**
 * @relay/cli — capsule export/import (M4).
 *
 * A capsule is a gzipped ustar archive rooted at `relay-capsule/`:
 *   relay-capsule/manifest.json
 *   relay-capsule/effects.json               EffectRecord[] (statuses preserved)
 *   relay-capsule/artifacts/index.json       ArtifactRecord[]
 *   relay-capsule/artifacts/objects/<ab>/<digest>
 *   relay-capsule/capabilities.yaml          (optional, from source workspace)
 *   relay-capsule/adapter/context.json       (optional opaque adapter material)
 *   relay-capsule/evidence/export.json       MigrationEvidence
 *
 * Export is atomic: the archive is assembled in a temp file and renamed
 * into place only when complete, so an interrupted export never leaves an
 * apparently-valid capsule (T12). Import re-hashes every file against the
 * manifest before anything touches the target workspace (T13). Secrets are
 * excluded by construction: only the allow-listed paths above are packed
 * and capsule code never reads the environment (T14).
 */
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CAPSULE_ROOT,
  RELAY_VERSION,
  validateManifest,
  type CapsuleFileEntry,
  type CapsuleManifest,
  type EffectRecord,
  type MigrationEvidence,
} from "@relay/core";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { ArtifactStore, type ArtifactRecord } from "@relay/artifact-fs";
import { createTar, extractTar, gzip, gunzip, sha256Hex, type TarEntry } from "./tar.js";

export interface ExportOptions {
  /** Source workspace directory (journal at .relay/storage.db, artifacts at .relay/artifacts). */
  workspace: string;
  /** Output capsule file path. */
  output: string;
  /** Optional capabilities file to embed (usually <workspace>/relay.capabilities.yaml). */
  capabilitiesPath?: string | undefined;
  /** Optional opaque adapter material (JSON file). */
  adapterContextPath?: string | undefined;
  /** Injectable clock for determinism. */
  now?: () => number;
  /** Test crash seam: called after packing each entry; throw to simulate death. */
  onEntry?: (index: number, total: number) => void;
}

export interface ExportResult {
  manifest: CapsuleManifest;
  manifestSha256: string;
  capsulePath: string;
  entryCount: number;
}

function jsonEntry(path: string, value: unknown): TarEntry {
  return { name: path, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

export async function exportCapsule(options: ExportOptions): Promise<ExportResult> {
  const now = options.now ?? (() => Date.now());
  const journal = await SqliteEffectJournal.open({
    path: join(options.workspace, ".relay", "storage.db"),
  });
  let effects: EffectRecord[];
  try {
    effects = await journal.list();
  } finally {
    journal.close();
  }
  const store = await ArtifactStore.open({ root: join(options.workspace, ".relay", "artifacts") });
  const artifactRecords = await store.list();
  const objectPaths = new Set<string>();
  for (const record of artifactRecords) {
    objectPaths.add(join(record.digest.slice(0, 2), record.digest));
  }

  const entries: TarEntry[] = [];
  const files: CapsuleFileEntry[] = [];
  const pushEntry = (entry: TarEntry): void => {
    entries.push(entry);
    files.push({ path: entry.name, sha256: sha256Hex(entry.data), byteSize: entry.data.byteLength });
  };

  pushEntry(jsonEntry(`${CAPSULE_ROOT}/effects.json`, effects));
  pushEntry(jsonEntry(`${CAPSULE_ROOT}/artifacts/index.json`, artifactRecords));
  for (const objectPath of [...objectPaths].sort()) {
    const digest = objectPath.split("/")[1] ?? "";
    const data = await store.content({ digest } as ArtifactRecord);
    pushEntry({ name: `${CAPSULE_ROOT}/artifacts/objects/${objectPath}`, data });
  }
  if (options.capabilitiesPath !== undefined) {
    pushEntry({
      name: `${CAPSULE_ROOT}/capabilities.yaml`,
      data: Buffer.from(await readFile(options.capabilitiesPath, "utf8"), "utf8"),
    });
  }
  if (options.adapterContextPath !== undefined) {
    pushEntry({
      name: `${CAPSULE_ROOT}/adapter/context.json`,
      data: Buffer.from(await readFile(options.adapterContextPath, "utf8"), "utf8"),
    });
  }

  const manifest: CapsuleManifest = {
    schema: "relay.capsule/1",
    relayVersion: RELAY_VERSION,
    createdAt: now(),
    workspace: ".",
    counts: {
      effects: effects.length,
      artifactRecords: artifactRecords.length,
      artifactObjects: objectPaths.size,
    },
    files: [], // filled after evidence hashing below
    integrity: { algorithm: "sha256" },
  };

  const exportEvidence: MigrationEvidence = {
    schema: "relay.migration/1",
    direction: "export",
    at: now(),
    counts: manifest.counts,
  };

  // The evidence file is hashed into the manifest like every other file; it
  // carries no manifest hash (that would be circular) — per-file hashes plus
  // the manifest's own presence at a fixed path cover archive integrity.
  const evidenceBuffer = Buffer.from(`${JSON.stringify(exportEvidence, null, 2)}\n`, "utf8");
  const evidenceEntry: TarEntry = { name: `${CAPSULE_ROOT}/evidence/export.json`, data: evidenceBuffer };

  manifest.files = [...files.map((f) => ({ ...f })), {
    path: evidenceEntry.name,
    sha256: sha256Hex(evidenceEntry.data),
    byteSize: evidenceEntry.data.byteLength,
  }];
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const finalEntries: TarEntry[] = [
    { name: `${CAPSULE_ROOT}/manifest.json`, data: manifestBuffer },
    ...entries,
    evidenceEntry,
  ];

  // T12 crash seam: invoked per entry during assembly; a throw here leaves
  // no output file at all (rename happens only after full assembly).
  const total = finalEntries.length;
  for (let i = 0; i < total; i += 1) {
    options.onEntry?.(i + 1, total);
  }

  const archive = gzip(createTar(finalEntries));
  const tmpDir = await mkdtemp(join(tmpdir(), "relay-capsule-"));
  try {
    const tmpPath = join(tmpDir, "capsule.tar.gz.tmp");
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(archive);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await mkdir(dirname(options.output), { recursive: true });
    await rename(tmpPath, options.output);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  return {
    manifest,
    manifestSha256: sha256Hex(manifestBuffer),
    capsulePath: options.output,
    entryCount: finalEntries.length,
  };
}

export interface ImportResult {
  manifest: CapsuleManifest;
  counts: CapsuleManifest["counts"];
  targetWorkspace: string;
  effectsPreserved: { key: string; status: string }[];
}

export interface ImportOptions {
  /** Capsule file path. */
  capsule: string;
  /** Target workspace directory (must not be an active source; single-writer migration). */
  workspace: string;
  /** Reject instead of overwrite when target already has Relay state. */
  allowOverwrite?: boolean | undefined;
  now?: () => number;
}

export async function importCapsule(options: ImportOptions): Promise<ImportResult> {
  const raw = await readFile(options.capsule);
  let entries: TarEntry[];
  try {
    entries = extractTar(gunzip(raw));
  } catch (err) {
    throw new Error(`capsule is not a valid gzip/ustar archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byPath = new Map(entries.map((entry) => [entry.name, entry]));

  const manifestEntry = byPath.get(`${CAPSULE_ROOT}/manifest.json`);
  if (manifestEntry === undefined) throw new Error("capsule has no manifest.json");
  const manifest = validateManifest(safeJsonParse(manifestEntry.data, "manifest.json"));

  // T13: re-hash every manifest file; extra/missing files are both fatal.
  const manifestPaths = new Set(manifest.files.map((f) => f.path));
  for (const file of manifest.files) {
    const entry = byPath.get(file.path);
    if (entry === undefined) throw new Error(`capsule missing declared file: ${file.path}`);
    if (entry.data.byteLength !== file.byteSize) {
      throw new Error(`capsule file size mismatch: ${file.path} (${entry.data.byteLength} != ${file.byteSize})`);
    }
    const digest = sha256Hex(entry.data);
    if (digest !== file.sha256) throw new Error(`capsule file hash mismatch: ${file.path}`);
  }
  for (const entry of entries) {
    if (entry.name === `${CAPSULE_ROOT}/manifest.json`) continue;
    if (!manifestPaths.has(entry.name)) throw new Error(`capsule contains undeclared file: ${entry.name}`);
  }

  const effects = safeJsonParse(byPath.get(`${CAPSULE_ROOT}/effects.json`)?.data, "effects.json") as EffectRecord[];
  if (!Array.isArray(effects)) throw new Error("capsule effects.json is not an array");
  const artifactRecords = safeJsonParse(
    byPath.get(`${CAPSULE_ROOT}/artifacts/index.json`)?.data,
    "artifacts/index.json",
  ) as ArtifactRecord[];
  if (!Array.isArray(artifactRecords)) throw new Error("capsule artifacts/index.json is not an array");

  // Guard against clobbering an active workspace (activation boundary).
  const journalPath = join(options.workspace, ".relay", "storage.db");
  const existing = await SqliteEffectJournal.open({ path: journalPath });
  let existingCount = 0;
  try {
    existingCount = (await existing.list()).length;
  } finally {
    existing.close();
  }
  if (existingCount > 0 && options.allowOverwrite !== true) {
    throw new Error(`target workspace already holds ${existingCount} effect records; pass --overwrite to replace`);
  }

  // Stage everything into a temp dir, then commit by rename/copy.
  const stage = await mkdtemp(join(tmpdir(), "relay-import-"));
  try {
    // Objects + records land in a staged artifact root.
    const stagedArtifacts = join(stage, "artifacts");
    await mkdir(join(stagedArtifacts, "objects"), { recursive: true });
    await mkdir(join(stagedArtifacts, "records"), { recursive: true });
    for (const record of artifactRecords) {
      const objectEntry = byPath.get(`${CAPSULE_ROOT}/artifacts/objects/${record.digest.slice(0, 2)}/${record.digest}`);
      if (objectEntry === undefined) throw new Error(`artifact object missing from capsule: ${record.digest}`);
      if (sha256Hex(objectEntry.data) !== record.digest) {
        throw new Error(`artifact object content does not match its digest: ${record.digest}`);
      }
      await mkdir(dirname(join(stagedArtifacts, "objects", record.digest.slice(0, 2), record.digest)), {
        recursive: true,
      });
      await writeFile(join(stagedArtifacts, "objects", record.digest.slice(0, 2), record.digest), objectEntry.data);
      await writeFile(
        join(stagedArtifacts, "records", `${record.id}.json`),
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    }

    // Journal import: statuses preserved verbatim (UNKNOWN never auto-converts).
    const journal = await SqliteEffectJournal.open({ path: join(stage, "storage.db") });
    try {
      await journal.replaceAll(effects);
    } finally {
      journal.close();
    }

    const capabilitiesEntry = byPath.get(`${CAPSULE_ROOT}/capabilities.yaml`);
    if (capabilitiesEntry !== undefined) {
      await writeFile(join(stage, "relay.capabilities.yaml"), capabilitiesEntry.data);
    }

    // Commit: copy staged state into the target workspace.
    const relayDir = join(options.workspace, ".relay");
    await mkdir(relayDir, { recursive: true });
    await copyFile(join(stage, "storage.db"), journalPath);
    for (const name of ["storage.db-wal", "storage.db-shm"]) {
      await rm(join(stage, name), { force: true });
    }
    const targetArtifacts = join(relayDir, "artifacts");
    await rm(targetArtifacts, { recursive: true, force: true });
    await mkdir(dirname(targetArtifacts), { recursive: true });
    await rename(stagedArtifacts, targetArtifacts);
    if (capabilitiesEntry !== undefined) {
      await rename(join(stage, "relay.capabilities.yaml"), join(options.workspace, "relay.capabilities.yaml"));
    }
    return {
      manifest,
      counts: manifest.counts,
      targetWorkspace: options.workspace,
      effectsPreserved: effects.map((e) => ({ key: e.key, status: e.status })),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function safeJsonParse(data: Buffer | undefined, what: string): unknown {
  if (data === undefined) throw new Error(`capsule missing ${what}`);
  try {
    return JSON.parse(data.toString("utf8"));
  } catch (err) {
    throw new Error(`capsule ${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
