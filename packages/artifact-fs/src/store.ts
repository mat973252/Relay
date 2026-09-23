/**
 * @relay/artifact-fs — content-addressed artifact store + lineage (M2).
 *
 * Layout under the artifact root:
 *   objects/<digest[0:2]>/<digest>   immutable content blobs (CAS)
 *   records/<record-id>.json         artifact metadata (atomic JSON sidecars)
 *   tmp/                             in-flight temp files (never trusted)
 *
 * Write ordering enforces the T09 invariant: a record file is only ever
 * renamed into place AFTER its content object exists, so any parseable
 * record always points at real content. Temp leftovers from crashes are
 * inert garbage (no valid metadata references them).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SimulatedProcessDeath, type CrashPoint } from "@relay/core";

export type ArtifactWriteCrashPoint = "after-object-tmp" | "after-object-rename" | "after-meta-tmp";

export interface ArtifactProducer {
  /** e.g. "tool", "agent", "human", "pipeline" */
  type: string;
  /** Producer-instance identifier (opaque). */
  id: string;
}

/** External execution references, all optional and opaque to the store. */
export interface ArtifactRefs {
  session?: string | undefined;
  run?: string | undefined;
  toolCall?: string | undefined;
}

export interface ArtifactRecord {
  id: string;
  /** Canonical identity: artifact://sha256/<digest> */
  artifactId: string;
  digest: string;
  byteSize: number;
  mediaType: string;
  producer: ArtifactProducer;
  /** Parent artifact RECORD ids (lineage edges). */
  parents: string[];
  refs: ArtifactRefs;
  createdAt: number;
}

export interface WriteArtifactInput {
  content: string | Uint8Array;
  mediaType: string;
  producer: ArtifactProducer;
  parents?: string[];
  refs?: ArtifactRefs;
  now?: () => number;
  /** Test/diagnostic crash seam inside the atomic write sequence. */
  crash?: { point: ArtifactWriteCrashPoint; kill: (point: ArtifactWriteCrashPoint) => void };
}

export interface LineageNode {
  record: ArtifactRecord;
  parents: LineageNode[];
}

export interface IntegrityReport {
  checkedObjects: number;
  checkedRecords: number;
  problems: string[];
}

export interface ArtifactStoreOptions {
  root: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class ArtifactStore {
  private constructor(private readonly root: string) {}

  static async open(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    const store = new ArtifactStore(options.root);
    await mkdir(join(options.root, "objects"), { recursive: true });
    await mkdir(join(options.root, "records"), { recursive: true });
    await mkdir(join(options.root, "tmp"), { recursive: true });
    return store;
  }

  private objectPath(digest: string): string {
    return join(this.root, "objects", digest.slice(0, 2), digest);
  }

  private recordPath(id: string): string {
    return join(this.root, "records", `${id}.json`);
  }

  /** Atomic durable write: temp file → fsync → rename into place. */
  private async atomicWrite(path: string, data: Uint8Array): Promise<void> {
    const tmpPath = join(this.root, "tmp", randomUUID());
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await mkdir(dirname(path), { recursive: true });
    await rename(tmpPath, path);
  }

  async write(input: WriteArtifactInput): Promise<ArtifactRecord> {
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    const digest = createHash("sha256").update(content).digest("hex");
    const now = input.now ?? (() => Date.now());

    const objectTarget = this.objectPath(digest);
    const objectExists = await stat(objectTarget).then(
      () => true,
      () => false,
    );
    if (!objectExists) {
      // Stage the object as a temp file first so the crash seam can observe
      // "temp written, not yet renamed".
      const tmpPath = join(this.root, "tmp", randomUUID());
      const fh = await open(tmpPath, "w");
      try {
        await fh.writeFile(content);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (input.crash?.point === "after-object-tmp") input.crash.kill(input.crash.point);
      await mkdir(dirname(objectTarget), { recursive: true });
      await rename(tmpPath, objectTarget);
    }
    if (input.crash?.point === "after-object-rename") input.crash.kill(input.crash.point);

    const record: ArtifactRecord = {
      id: randomUUID(),
      artifactId: `artifact://sha256/${digest}`,
      digest,
      byteSize: content.byteLength,
      mediaType: input.mediaType,
      producer: input.producer,
      parents: [...(input.parents ?? [])],
      refs: input.refs ?? {},
      createdAt: now(),
    };
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const metaTmp = join(this.root, "tmp", `${record.id}.json.tmp`);
    const fh = await open(metaTmp, "w");
    try {
      await fh.writeFile(payload);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (input.crash?.point === "after-meta-tmp") input.crash.kill(input.crash.point);
    await rename(metaTmp, this.recordPath(record.id));
    return record;
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    try {
      const raw = await readFile(this.recordPath(id), "utf8");
      return JSON.parse(raw) as ArtifactRecord;
    } catch {
      return undefined;
    }
  }

  /** Resolves `artifact://sha256/<digest>`, a bare record id, or a bare digest. */
  async resolve(ref: string): Promise<ArtifactRecord | undefined> {
    const digestMatch = ref.match(/^(?:artifact:\/\/sha256\/)?([0-9a-f]{64})$/);
    if (digestMatch !== null) {
      const digest = digestMatch[1] ?? "";
      const records = await this.list();
      return records.find((record) => record.digest === digest);
    }
    return this.get(ref);
  }

  async list(): Promise<ArtifactRecord[]> {
    const entries = await readdir(join(this.root, "records"));
    const records: ArtifactRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.root, "records", entry), "utf8");
        const record = JSON.parse(raw) as ArtifactRecord;
        if (SHA256_HEX.test(record.digest)) records.push(record);
      } catch {
        // Unparseable/partial record files cannot exist thanks to atomic
        // rename; skip defensively anyway.
      }
    }
    records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    return records;
  }

  async content(record: ArtifactRecord): Promise<Buffer> {
    return readFile(this.objectPath(record.digest));
  }

  /** Walks the parent graph breadth-first; missing parents are reported as problems. */
  async lineage(ref: string): Promise<{ root: LineageNode | undefined; problems: string[] }> {
    const problems: string[] = [];
    const cache = new Map<string, LineageNode>();
    const visiting = new Set<string>();

    const build = async (id: string): Promise<LineageNode | undefined> => {
      if (cache.has(id)) return cache.get(id);
      if (visiting.has(id)) {
        problems.push(`cycle detected at ${id}`);
        return undefined;
      }
      visiting.add(id);
      const record = await this.get(id);
      if (record === undefined) {
        problems.push(`missing parent record ${id}`);
        visiting.delete(id);
        return undefined;
      }
      const parents: LineageNode[] = [];
      for (const parentId of record.parents) {
        const node = await build(parentId);
        if (node !== undefined) parents.push(node);
      }
      visiting.delete(id);
      const node: LineageNode = { record, parents };
      cache.set(id, node);
      return node;
    };

    const digestMatch = ref.match(/^(?:artifact:\/\/sha256\/)?([0-9a-f]{64})$/);
    const root = digestMatch !== null ? await this.resolve(ref) : await this.get(ref);
    if (root === undefined) return { root: undefined, problems: [`unknown artifact ${ref}`] };
    const rootNode = await build(root.id);
    return { root: rootNode, problems };
  }

  /** Re-hashes every object referenced by a record (T09/T22 evidence helper). */
  async verify(): Promise<IntegrityReport> {
    const records = await this.list();
    const problems: string[] = [];
    for (const record of records) {
      let buffer: Buffer;
      try {
        buffer = await this.content(record);
      } catch {
        problems.push(`${record.id}: object missing for digest ${record.digest}`);
        continue;
      }
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (digest !== record.digest) problems.push(`${record.id}: digest mismatch (${digest} != ${record.digest})`);
      if (buffer.byteLength !== record.byteSize) {
        problems.push(`${record.id}: size mismatch (${buffer.byteLength} != ${record.byteSize})`);
      }
      for (const parent of record.parents) {
        if ((await this.get(parent)) === undefined) problems.push(`${record.id}: missing parent ${parent}`);
      }
    }
    return { checkedObjects: records.length, checkedRecords: records.length, problems };
  }

  /** Removes stale temp files (crash leftovers). Never touches objects/records. */
  async gcTemp(): Promise<number> {
    let removed = 0;
    const entries = await readdir(join(this.root, "tmp")).catch(() => [] as string[]);
    for (const entry of entries) {
      await rm(join(this.root, "tmp", entry), { force: true });
      removed += 1;
    }
    return removed;
  }
}
