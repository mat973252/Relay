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
 * manifest before anything touches the target workspace (T13). The exporter
 * never reads the environment. Artifact content
 * and explicitly supplied adapter files are opaque caller-owned data and
 * must be reviewed for secrets before export.
 */
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
  /** Optional extra adapter files packed under relay-capsule/adapter/ (path relative to that root, POSIX). */
  extraAdapterFiles?: { path: string; data: Buffer }[] | undefined;
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
  // Capability contract auto-detection (round-trip coherence): an imported
  // contract inside .relay wins over a workspace-root authoring copy.
  const capabilitiesPath =
    options.capabilitiesPath ??
    (await stat(join(options.workspace, ".relay", "relay.capabilities.yaml")).then(
      () => join(options.workspace, ".relay", "relay.capabilities.yaml"),
      () =>
        stat(join(options.workspace, "relay.capabilities.yaml")).then(
          () => join(options.workspace, "relay.capabilities.yaml"),
          () => undefined as string | undefined,
        ),
    ));
  const artifactRecords = await store.list();
  const objectDigests = new Set<string>();
  for (const record of artifactRecords) {
    objectDigests.add(record.digest);
  }

  const entries: TarEntry[] = [];
  const files: CapsuleFileEntry[] = [];
  const pushEntry = (entry: TarEntry): void => {
    entries.push(entry);
    files.push({ path: entry.name, sha256: sha256Hex(entry.data), byteSize: entry.data.byteLength });
  };

  pushEntry(jsonEntry(`${CAPSULE_ROOT}/effects.json`, effects));
  pushEntry(jsonEntry(`${CAPSULE_ROOT}/artifacts/index.json`, artifactRecords));
  for (const digest of [...objectDigests].sort()) {
    const data = await store.content({ digest } as ArtifactRecord);
    pushEntry({ name: `${CAPSULE_ROOT}/artifacts/objects/${digest.slice(0, 2)}/${digest}`, data });
  }
  if (capabilitiesPath !== undefined) {
    pushEntry({
      name: `${CAPSULE_ROOT}/capabilities.yaml`,
      data: Buffer.from(await readFile(capabilitiesPath, "utf8"), "utf8"),
    });
  }
  if (options.adapterContextPath !== undefined) {
    pushEntry({
      name: `${CAPSULE_ROOT}/adapter/context.json`,
      data: Buffer.from(await readFile(options.adapterContextPath, "utf8"), "utf8"),
    });
  }
  for (const extra of options.extraAdapterFiles ?? []) {
    validateEntryPath(extra.path);
    pushEntry({ name: `${CAPSULE_ROOT}/adapter/${extra.path}`, data: extra.data });
  }

  const manifest: CapsuleManifest = {
    schema: "relay.capsule/1",
    relayVersion: RELAY_VERSION,
    createdAt: now(),
    workspace: ".",
    counts: {
      effects: effects.length,
      artifactRecords: artifactRecords.length,
      artifactObjects: objectDigests.size,
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
  await mkdir(dirname(options.output), { recursive: true });
  const tmpDir = await mkdtemp(join(dirname(options.output), ".relay-capsule-"));
  try {
    const tmpPath = join(tmpDir, "capsule.tar.gz.tmp");
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(archive);
      await fh.sync();
    } finally {
      await fh.close();
    }
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
  /** true when the capsule carried a capability contract (now at <workspace>/.relay/relay.capabilities.yaml). */
  importedContract: boolean;
}

export interface ImportOptions {
  /** Capsule file path. */
  capsule: string;
  /** Target workspace directory (must not be an active source; single-writer migration). */
  workspace: string;
  /** Reject instead of overwrite when target already has Relay state. */
  allowOverwrite?: boolean | undefined;
  now?: () => number;
  /** M6 crash seam for the import commit sequence. */
  crash?: { point: ImportCrashPoint; kill: (point: ImportCrashPoint) => void } | undefined;
}

export type ImportCrashPoint =
  | "after-validation"
  | "after-stage"
  | "after-old-swap"
  | "after-relay-commit"
  | "after-commit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export async function importCapsule(options: ImportOptions): Promise<ImportResult> {
  const raw = await readFile(options.capsule);
  let entries: TarEntry[];
  try {
    entries = extractTar(gunzip(raw));
  } catch (err) {
    throw new Error(`capsule is not a valid gzip/ustar archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  const byPath = new Map(entries.map((entry) => [entry.name, entry]));
  if (byPath.size !== entries.length) throw new Error("duplicate capsule entry path");

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
  const recordIds = new Set<string>();
  for (const record of artifactRecords) {
    if (
      typeof record !== "object" || record === null ||
      typeof record.id !== "string" || !UUID.test(record.id) || recordIds.has(record.id) ||
      typeof record.digest !== "string" || !SHA256.test(record.digest) ||
      record.artifactId !== `artifact://sha256/${record.digest}` ||
      !Number.isSafeInteger(record.byteSize) || record.byteSize < 0 ||
      !Array.isArray(record.parents) || !record.parents.every((parent) => typeof parent === "string" && UUID.test(parent))
    ) {
      throw new Error("invalid artifact record in capsule");
    }
    recordIds.add(record.id);
  }
  if (
    manifest.counts.effects !== effects.length ||
    manifest.counts.artifactRecords !== artifactRecords.length ||
    manifest.counts.artifactObjects !== new Set(artifactRecords.map((record) => record.digest)).size
  ) {
    throw new Error("capsule manifest counts do not match contents");
  }

  const relayDir = join(options.workspace, ".relay");
  options.crash && options.crash.point === "after-validation" && options.crash.kill("after-validation");

  // Recovery from a previous interrupted import, BEFORE any new staging:
  //  - stale staging dirs are inert garbage; remove them;
  //  - if a parked old state exists and no .relay does, the previous import
  //    died between parking and installation: restore the old pair first so
  //    this run (and `relay doctor`) always sees one coherent pair.
  const parkedPath = join(options.workspace, ".relay.pre-import-old");
  for (const entry of await readdir(options.workspace).catch(() => [] as string[])) {
    if (entry.startsWith(".relay-import-")) {
      await rm(join(options.workspace, entry), { recursive: true, force: true });
    }
  }
  const relayMissing = await stat(relayDir).then(
    () => false,
    () => true,
  );
  if (relayMissing) {
    const parkedExists = await stat(parkedPath).then(
      () => true,
      () => false,
    );
    if (parkedExists) await rename(parkedPath, relayDir);
  }

  // Any existing Relay state may contain artifacts or a capability contract
  // even when the effect journal is empty or absent.
  const targetHasRelayState = await stat(relayDir).then(
    () => true,
    () => false,
  );
  if (targetHasRelayState && options.allowOverwrite !== true) {
    throw new Error("target workspace already holds Relay state; pass --overwrite to replace");
  }

  // Stage a COMPLETE replacement .relay on the target filesystem; the commit
  // is a single directory swap that carries the imported capability contract
  // with it (relay.capabilities.yaml inside .relay), so Relay state and its
  // capability requirements can never be observed in different generations.
  await mkdir(options.workspace, { recursive: true });
  const stage = await mkdtemp(join(options.workspace, ".relay-import-"));
  try {
    const stagedRelay = join(stage, "relay");
    const stagedArtifacts = join(stagedRelay, "artifacts");
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
    const journal = await SqliteEffectJournal.open({ path: join(stagedRelay, "storage.db") });
    try {
      await journal.replaceAll(effects);
    } finally {
      journal.close();
    }
    for (const name of ["storage.db-wal", "storage.db-shm"]) {
      await rm(join(stagedRelay, name), { force: true });
    }

    // Adapter material (e.g. migrated Pi session files) lands under .relay/adapter/.
    for (const entry of entries) {
      if (entry.name.startsWith(`${CAPSULE_ROOT}/adapter/`)) {
        const relative = entry.name.slice(`${CAPSULE_ROOT}/adapter/`.length);
        const target = join(stagedRelay, "adapter", relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data);
      }
    }
    const capabilitiesEntry = byPath.get(`${CAPSULE_ROOT}/capabilities.yaml`);
    if (capabilitiesEntry !== undefined) {
      // Part of the imported state: staged INSIDE the replacement .relay so it
      // crosses the commit boundary in the same rename. The workspace-root
      // relay.capabilities.yaml (if any) is operator territory and is never
      // touched by an import.
      await writeFile(join(stagedRelay, "relay.capabilities.yaml"), capabilitiesEntry.data);
    }
    options.crash && options.crash.point === "after-stage" && options.crash.kill("after-stage");

    // Commit: all-or-nothing directory swap. Crash windows leave either the
    // old state intact, the old state parked in .relay.pre-import-old (with
    // no .relay), or the fully imported state — never a mixture.
    await mkdir(options.workspace, { recursive: true });
    const relayExists = await stat(relayDir).then(
      () => true,
      () => false,
    );
    if (relayExists) {
      const parked = join(options.workspace, ".relay.pre-import-old");
      await rm(parked, { recursive: true, force: true });
      await rename(relayDir, parked);
    }
    options.crash && options.crash.point === "after-old-swap" && options.crash.kill("after-old-swap");
    await rename(stagedRelay, relayDir);
    // The single commit boundary has been crossed: Relay state and the
    // imported capability contract became visible together. A death here
    // (after-relay-commit) or after cleanup (after-commit) still leaves the
    // new-new pair governing.
    options.crash && options.crash.point === "after-relay-commit" && options.crash.kill("after-relay-commit");
    if (relayExists) {
      await rm(parkedPath, { recursive: true, force: true });
    }
    options.crash && options.crash.point === "after-commit" && options.crash.kill("after-commit");
    return {
      manifest,
      counts: manifest.counts,
      targetWorkspace: options.workspace,
      effectsPreserved: effects.map((e) => ({ key: e.key, status: e.status })),
      importedContract: capabilitiesEntry !== undefined,
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

function validateEntryPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new Error(`invalid capsule adapter entry path: ${path}`);
  }
}
