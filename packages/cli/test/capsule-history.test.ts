/**
 * Capsule carriage of effect transition evidence: events round-trip with the
 * journal, a capsule without the evidence file imports as snapshot-only
 * (history unavailable), and forged/contradictory evidence is rejected
 * before anything touches the target — the latest-state row, never the
 * event stream, remains the execution authority.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { exportCapsule, importCapsule } from "../src/capsule.js";
import { createTar, extractTar, gunzip, gzip, sha256Hex, type TarEntry } from "../src/tar.js";
import { SqliteEffectJournal } from "@relay/storage-sqlite";
import { CAPSULE_ROOT, type EffectRecord, type EffectTransitionEvent } from "@relay/core";

const tmp = mkdtempSync(join(tmpdir(), "relay-capsule-history-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const EVENTS_PATH = `${CAPSULE_ROOT}/effect-events.json`;
const EFFECTS_PATH = `${CAPSULE_ROOT}/effects.json`;
const MANIFEST_PATH = `${CAPSULE_ROOT}/manifest.json`;

function prepared(id: string, key: string, at: number): EffectRecord {
  return {
    id,
    key,
    kind: "test/kind",
    requestHash: `h-${id}`,
    replay: "never",
    status: "PREPARED",
    remoteRef: undefined,
    resultJson: undefined,
    reason: undefined,
    createdAt: at,
    submittedAt: undefined,
    settledAt: undefined,
    updatedAt: at,
  };
}

async function seedJournal(workspace: string): Promise<void> {
  const journal = await SqliteEffectJournal.open({ path: join(workspace, ".relay", "storage.db") });
  try {
    await journal.insertPrepared(prepared("c1", "op/confirmed", 1));
    await journal.markSubmitted("c1", 2);
    await journal.markUnknown("c1", "ambiguous: reset", 3, "execute");
    await journal.markConfirmed("c1", { remoteRef: "fx-1", resultJson: "{\"v\":1}", at: 4, cause: "reconcile" });
    await journal.insertPrepared(prepared("s1", "op/submitted", 5));
    await journal.markSubmitted("s1", 6);
  } finally {
    journal.close();
  }
}

/** Rewrites one JSON entry and re-declares its hash/size in the manifest. */
function rewrite(entries: TarEntry[], path: string, value: unknown): TarEntry[] {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const manifestEntry = entries.find((e) => e.name === MANIFEST_PATH)!;
  const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as {
    counts: Record<string, number>;
    files: { path: string; sha256: string; byteSize: number }[];
  };
  const file = manifest.files.find((f) => f.path === path)!;
  file.sha256 = sha256Hex(data);
  file.byteSize = data.byteLength;
  if (path === EVENTS_PATH && Array.isArray(value)) manifest.counts.effectEvents = value.length;
  manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2));
  return entries.map((e) => (e.name === path ? { name: e.name, data } : e));
}

function pack(entries: TarEntry[], file: string): string {
  const path = join(tmp, file);
  writeFileSync(path, gzip(createTar(entries)));
  return path;
}

async function readEvents(capsule: string): Promise<{ entries: TarEntry[]; events: EffectTransitionEvent[] }> {
  const entries = extractTar(gunzip(readFileSync(capsule)));
  const entry = entries.find((e) => e.name === EVENTS_PATH);
  assert.ok(entry !== undefined, "capsule carries effect-events.json");
  return { entries, events: JSON.parse(entry.data.toString("utf8")) as EffectTransitionEvent[] };
}

describe("capsule effect transition evidence", () => {
  it("round-trips events with their records and keeps seq/order/coverage", async () => {
    const source = join(tmp, "src-roundtrip");
    await seedJournal(source);
    const capsule = join(tmp, "roundtrip.tar.gz");
    const exported = await exportCapsule({ workspace: source, output: capsule });
    assert.equal(exported.manifest.counts.effects, 2);
    assert.equal(exported.manifest.counts.effectEvents, 6);
    const { events } = await readEvents(capsule);
    assert.equal(events.length, 6);

    const target = join(tmp, "dst-roundtrip");
    const imported = await importCapsule({ capsule, workspace: target });
    assert.equal(imported.counts.effectEvents, 6);
    const journal = await SqliteEffectJournal.open({ path: join(target, ".relay", "storage.db") });
    try {
      const histories = await journal.listHistory();
      assert.equal(histories.length, 2);
      const confirmed = histories.find((h) => h.record.key === "op/confirmed")!;
      assert.equal(confirmed.coverage, "observed");
      assert.deepEqual(
        confirmed.events.map((e) => `${e.fromStatus ?? "-"}>${e.toStatus}:${e.cause}`),
        ["->PREPARED:prepare", "PREPARED>SUBMITTED:submit", "SUBMITTED>UNKNOWN:execute", "UNKNOWN>CONFIRMED:reconcile"],
      );
      assert.deepEqual(
        (await journal.listEvents()).map((e) => e.seq),
        events.map((e) => e.seq),
        "sequence numbers preserved verbatim",
      );
      const submitted = histories.find((h) => h.record.key === "op/submitted")!;
      assert.equal(submitted.record.status, "SUBMITTED");
      assert.equal(submitted.coverage, "observed");
    } finally {
      journal.close();
    }
  });

  it("a capsule without effect-events.json imports as snapshot-only history", async () => {
    const source = join(tmp, "src-legacy");
    await seedJournal(source);
    const capsule = join(tmp, "legacy-src.tar.gz");
    await exportCapsule({ workspace: source, output: capsule });
    const entries = extractTar(gunzip(readFileSync(capsule)));
    const manifestEntry = entries.find((e) => e.name === MANIFEST_PATH)!;
    const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as {
      counts: Record<string, number>;
      files: { path: string }[];
    };
    manifest.files = manifest.files.filter((f) => f.path !== EVENTS_PATH);
    delete manifest.counts.effectEvents;
    manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2));
    const legacy = pack(entries.filter((e) => e.name !== EVENTS_PATH), "legacy.tar.gz");

    const target = join(tmp, "dst-legacy");
    const imported = await importCapsule({ capsule: legacy, workspace: target });
    assert.equal(imported.counts.effectEvents, undefined);
    assert.deepEqual(
      imported.effectsPreserved.map((e) => e.status).sort(),
      ["CONFIRMED", "SUBMITTED"],
      "statuses preserved verbatim without history",
    );
    const journal = await SqliteEffectJournal.open({ path: join(target, ".relay", "storage.db") });
    try {
      assert.equal((await journal.listEvents()).length, 0, "no transitions invented on import");
      for (const h of await journal.listHistory()) assert.equal(h.coverage, "unavailable");
    } finally {
      journal.close();
    }
  });

  it("rejects evidence that contradicts or forges the latest state before touching the target", async () => {
    const source = join(tmp, "src-forged");
    await seedJournal(source);
    const capsule = join(tmp, "forged-src.tar.gz");
    await exportCapsule({ workspace: source, output: capsule });
    const { entries, events } = await readEvents(capsule);
    const target = join(tmp, "dst-forged");

    // Forged completion: an event claims op/submitted reached CONFIRMED while
    // the record says SUBMITTED. History must not be accepted as authority.
    const forged = [
      ...events,
      { ...events.at(-1)!, seq: 99, effectId: "s1", key: "op/submitted", fromStatus: "SUBMITTED", toStatus: "CONFIRMED", cause: "reconcile", remoteRef: "fx-forged" },
    ];
    await assert.rejects(
      () => importCapsule({ capsule: pack(rewrite(entries, EVENTS_PATH, forged), "forged.tar.gz"), workspace: target }),
      /effect evidence contradicts/,
    );
    assert.equal(existsSync(join(target, ".relay")), false);

    // Broken chain: from-status does not follow the previous event.
    const broken = events.map((e) => (e.seq === events[1]!.seq ? { ...e, fromStatus: "UNKNOWN" } : e));
    await assert.rejects(
      () => importCapsule({ capsule: pack(rewrite(entries, EVENTS_PATH, broken), "broken.tar.gz"), workspace: target }),
      /effect evidence/,
    );

    // Orphan: an event for an effect id that is not in effects.json.
    const orphan = [...events, { ...events[0]!, seq: 100, effectId: "ghost", key: "op/ghost" }];
    await assert.rejects(
      () => importCapsule({ capsule: pack(rewrite(entries, EVENTS_PATH, orphan), "orphan.tar.gz"), workspace: target }),
      /effect evidence/,
    );

    // Duplicate seq.
    const dup = [...events, { ...events[2]! }];
    await assert.rejects(
      () => importCapsule({ capsule: pack(rewrite(entries, EVENTS_PATH, dup), "dup.tar.gz"), workspace: target }),
      /effect evidence/,
    );

    // Count mismatch between manifest and file.
    const entriesMismatch = rewrite(entries, EVENTS_PATH, events);
    const manifestEntry = entriesMismatch.find((e) => e.name === MANIFEST_PATH)!;
    const manifest = JSON.parse(manifestEntry.data.toString("utf8")) as { counts: Record<string, number> };
    manifest.counts.effectEvents = events.length + 1;
    manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2));
    await assert.rejects(
      () => importCapsule({ capsule: pack(entriesMismatch, "count.tar.gz"), workspace: target }),
      /counts do not match/,
    );

    // Effects tampered but events untouched: last event no longer matches the row.
    const effectsEntry = entries.find((e) => e.name === EFFECTS_PATH)!;
    const effects = JSON.parse(effectsEntry.data.toString("utf8")) as EffectRecord[];
    const tampered = effects.map((e) => (e.id === "s1" ? { ...e, status: "CONFIRMED" as const } : e));
    await assert.rejects(
      () => importCapsule({ capsule: pack(rewrite(entries, EFFECTS_PATH, tampered), "tampered.tar.gz"), workspace: target }),
      /effect evidence contradicts/,
    );
    assert.equal(existsSync(join(target, ".relay")), false);
  });
});
