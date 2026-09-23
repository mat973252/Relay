#!/usr/bin/env node
/**
 * @relay/cli — operator commands.
 *
 * M0: `relay doctor` runs the capability probes (pi CLI, SQLite storage,
 * artifact root) and reports a machine-checkable exit status:
 *
 *   0 = ok, 1 = degraded (warn), 2 = blocked (fail), 64 = usage error
 *
 * The CLI never reads or prints arbitrary environment values.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RELAY_VERSION,
  doctorExitCode,
  formatDoctorJson,
  formatDoctorReport,
  runDoctor,
  type DoctorProbeSpec,
  type ProbeOutcome,
} from "@relay/core";
import { probeSqliteStorage } from "@relay/storage-sqlite";
import { probeArtifactRoot } from "@relay/artifact-fs";

const USAGE = `relay — durable execution continuity for AI agents (M0)

usage:
  relay doctor [--json] [--storage PATH] [--artifacts PATH]
  relay --help

doctor exit codes:
  0 ok  |  1 degraded (warn)  |  2 blocked (fail)  |  64 usage error
`;

interface DoctorArgs {
  json: boolean;
  storage: string;
  artifacts: string;
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
    } else {
      usageError(`unknown argument for doctor: ${arg}`);
    }
  }
  return {
    json,
    storage: storage ?? join(cwd, ".relay", "storage.db"),
    artifacts: artifacts ?? join(cwd, ".relay", "artifacts"),
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
  process.stdout.write(args.json ? formatDoctorJson(result) : `${formatDoctorReport(result)}\n`);
  return doctorExitCode(result);
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
