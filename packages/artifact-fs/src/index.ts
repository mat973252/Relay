/**
 * @relay/artifact-fs — filesystem + SHA-256 content-addressed artifacts
 * (M0: accessibility/probe boundary only; full CAS + lineage comes later).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeOutcome } from "@relay/core";

export interface ArtifactProbeOptions {
  /** Root directory for Relay artifacts. */
  root: string;
}

const PROBE_MARKER = "relay-m0-artifact-probe\n";

/**
 * Real probe: creates the artifact root (if missing), writes one probe file,
 * reads it back, verifies the content, and removes it. Failures are reported,
 * never thrown, so the doctor can render them.
 */
export async function probeArtifactRoot(options: ArtifactProbeOptions): Promise<ProbeOutcome> {
  const { root } = options;
  const probeFile = join(root, "relay-probe.txt");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probeFile, PROBE_MARKER, "utf8");
    const readBack = await readFile(probeFile, "utf8");
    if (readBack !== PROBE_MARKER) {
      return { status: "fail", detail: `artifact probe content mismatch at ${probeFile}` };
    }
    await rm(probeFile, { force: true });
    return { status: "ok", detail: `artifact root read/write verified at ${root}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "fail", detail: `artifact probe failed at ${root}: ${message}` };
  }
}
