#!/usr/bin/env node
/**
 * @relay/cli — operator commands.
 *
 * M0: `relay doctor` — capability probes with machine-checkable exit status.
 * M2: `relay artifacts` / `relay lineage <ref>` — artifact registry views.
 *
 * Exit codes: 0 ok | 1 degraded (warn) | 2 blocked (fail) | 64 usage |
 * 66 unknown artifact reference.
 *
 * The CLI never reads or prints arbitrary environment values.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RELAY_VERSION,
  activationExitCode,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorProbeSpec,
  type ProbeOutcome,
} from "@relay/core";
import { probeSqliteStorage } from "@relay/storage-sqlite";
import { ArtifactStore, probeArtifactRoot, type ArtifactRecord, type LineageNode } from "@relay/artifact-fs";
import { evaluateCapabilitiesFile } from "./capabilities.js";

const USAGE = `relay — durable execution continuity for AI agents (M2)

usage:
  relay doctor [--json] [--storage PATH] [--artifacts PATH] [--capabilities PATH]
  relay artifacts [--json] [--artifacts PATH]
  relay lineage <artifact-ref> [--json] [--artifacts PATH]
  relay --help

<artifact-ref> accepts a record id, a sha256 digest, or artifact://sha256/<digest>

doctor also evaluates ./relay.capabilities.yaml when present (schema
relay.capabilities/1; secret references are env var NAMES, never values)

doctor exit codes:
  0 ok/READY  |  1 degraded/DEGRADED  |  2 blocked/BLOCKED  |  64 usage error
`;

interface DoctorArgs {
  json: boolean;
  storage: string;
  artifacts: string;
  capabilities: string | undefined;
}

function usageError(message: string): never {
  process.stderr.write(`relay: ${message}\n${USAGE}`);
  process.exit(64);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    usageError(`${flag} requires a value`);
  }
  return value;
}

function parseDoctorArgs(argv: string[], cwd: string): DoctorArgs {
  let json = false;
  let storage: string | undefined;
  let artifacts: string | undefined;
  let capabilities: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--storage") {
      storage = requireValue(argv, i + 1, "--storage");
      i += 1;
    } else if (arg === "--artifacts") {
      artifacts = requireValue(argv, i + 1, "--artifacts");
      i += 1;
    } else if (arg === "--capabilities") {
      capabilities = requireValue(argv, i + 1, "--capabilities");
      i += 1;
    } else {
      usageError(`unknown argument for doctor: ${arg}`);
    }
  }
  return {
    json,
    storage: storage ?? join(cwd, ".relay", "storage.db"),
    artifacts: artifacts ?? join(cwd, ".relay", "artifacts"),
    capabilities,
  };
}

function probePiCli(): ProbeOutcome {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined || result.status !== 0) {
    return { status: "fail", detail: "pi CLI not available on PATH (pi --version failed)" };
  }
  const version = (result.stdout ?? "").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return { status: "fail", detail: `unexpected pi --version output: ${JSON.stringify(version)}` };
  }
  return { status: "ok", detail: `pi ${version} on PATH` };
}

interface ParsedFlags {
  json: boolean;
  artifacts: string;
  positional: string[];
}

function parseArtifactFlags(argv: string[], cwd: string): ParsedFlags {
  let json = false;
  let artifacts: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--artifacts") {
      artifacts = requireValue(argv, i + 1, "--artifacts");
      i += 1;
    } else if (arg.startsWith("--")) {
      usageError(`unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { json, artifacts: artifacts ?? join(cwd, ".relay", "artifacts"), positional };
}

function renderArtifactLine(record: ArtifactRecord): string {
  const parents = record.parents.length > 0 ? ` parents=${record.parents.length}` : "";
  return `${record.artifactId}  ${record.mediaType}  ${record.byteSize}B  ${record.producer.type}/${record.producer.id}${parents}  ${record.id}`;
}

function renderLineageTree(node: LineageNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const parentCount = node.parents.length;
  const suffix = depth === 0 ? "" : parentCount > 0 ? " ─┐" : "";
  const lines = [`${indent}${node.record.artifactId}  ${node.record.mediaType}  ${node.record.producer.type}/${node.record.producer.id}${suffix}`];
  for (const parent of node.parents) {
    lines.push(renderLineageTree(parent, depth + 1));
  }
  return lines.join("\n");
}

async function runArtifactsCommand(rest: string[], cwd: string): Promise<number> {
  const args = parseArtifactFlags(rest, cwd);
  if (args.positional.length > 0) usageError(`unexpected argument: ${args.positional[0]}`);
  const store = await ArtifactStore.open({ root: args.artifacts });
  const records = await store.list();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ schema: "relay.artifacts/1", artifacts: records })}\n`);
  } else {
    const lines = records.map(renderArtifactLine);
    process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "(no artifacts)\n");
  }
  return 0;
}

async function runLineageCommand(rest: string[], cwd: string): Promise<number> {
  const args = parseArtifactFlags(rest, cwd);
  if (args.positional.length !== 1) usageError("lineage requires exactly one <artifact-ref>");
  const ref = args.positional[0] ?? "";
  const store = await ArtifactStore.open({ root: args.artifacts });
  const { root, problems } = await store.lineage(ref);
  if (root === undefined) {
    process.stderr.write(`relay: unknown artifact ${ref}\n`);
    return 66;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ schema: "relay.lineage/1", root, problems })}\n`);
  } else {
    process.stdout.write(`${renderLineageTree(root)}\n`);
    for (const problem of problems) process.stdout.write(`! ${problem}\n`);
  }
  return 0;
}

export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 64;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "artifacts") {
    return runArtifactsCommand(rest, cwd);
  }
  if (command === "lineage") {
    return runLineageCommand(rest, cwd);
  }
  if (command !== "doctor") {
    usageError(`unknown command: ${command}`);
  }

  const args = parseDoctorArgs(rest, cwd);
  const probes: DoctorProbeSpec[] = [
    { id: "pi", label: "Pi CLI", run: async () => probePiCli() },
    { id: "storage", label: "SQLite storage", run: () => probeSqliteStorage({ path: args.storage }) },
    { id: "artifacts", label: "Artifact root", run: () => probeArtifactRoot({ root: args.artifacts }) },
  ];
  const result = await runDoctor({
    relayVersion: RELAY_VERSION,
    context: { cwd },
    probes,
  });

  // Capability contract (M3): evaluate relay.capabilities.yaml when present.
  const capabilitiesPath = args.capabilities ?? join(cwd, "relay.capabilities.yaml");
  const hasCapabilities = await import("node:fs")
    .then((fs) => fs.existsSync(capabilitiesPath))
    .catch(() => false);
  let capabilityLines: string[] = [];
  let capabilitiesJson: unknown = undefined;
  let exitCode = doctorExitCode(result);
  if (hasCapabilities) {
    try {
      const { evaluation } = await evaluateCapabilitiesFile({ path: capabilitiesPath });
      capabilityLines = [
        `capabilities (${capabilitiesPath}):`,
        ...evaluation.results.map(
          (r) =>
            `  [${r.state}${r.required ? "/required" : "/optional"}] ${r.label} (${r.id}): ${r.detail}`,
        ),
        `activation: ${evaluation.decision}`,
      ];
      capabilitiesJson = evaluation;
      const capabilityCode = activationExitCode(evaluation);
      exitCode = Math.max(exitCode, capabilityCode) as 0 | 1 | 2;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      capabilityLines = [`capabilities (${capabilitiesPath}): invalid — ${message}`];
      capabilitiesJson = { error: message };
      exitCode = 2;
    }
  }

  if (args.json) {
    const payload = {
      ...result,
      ...(capabilitiesJson === undefined ? {} : { capabilities: capabilitiesJson }),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    let text = formatDoctorReport(result);
    // The formatted report ends with summary/exit-code lines; splice the
    // capability section above them and re-derive the printed exit code.
    const lines = text.split("\n");
    const summaryIndex = lines.findIndex((line) => line.startsWith("summary:"));
    const head = summaryIndex === -1 ? lines : lines.slice(0, summaryIndex);
    const tail = summaryIndex === -1 ? [] : lines.slice(summaryIndex);
    tail[1] = `exit code: ${exitCode}`;
    text = [...head, ...capabilityLines, ...tail].join("\n");
    process.stdout.write(`${text}\n`);
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`relay: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(70);
    },
  );
}
