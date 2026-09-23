/**
 * @relay/cli — relay.capabilities.yaml parsing + probe construction (M3).
 *
 * YAML is the human-authored config format (the only YAML in Relay);
 * this module parses it into the pure `@relay/core` capability model and
 * builds real probes (command on PATH, node module import, HTTP HEAD/GET,
 * env-references). Secret references are env var NAMES; values are read via
 * the sanctioned env module and never appear in any output.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  evaluateCapabilities,
  type CapabilityCheckSpec,
  type CapabilityEvaluation,
  type CapabilityProbe,
  type CapabilitySpec,
} from "@relay/core";
import { envHeaderValue, envNamePresent } from "./env.js";

export interface ParsedCapabilitiesFile {
  schema: string;
  specs: CapabilitySpec[];
  path: string;
}

export function isCapabilityCheckSpec(value: unknown): value is CapabilityCheckSpec {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "command-on-path" ||
    kind === "node-module" ||
    kind === "http" ||
    kind === "env-ref" ||
    kind === "custom"
  );
}

/** Parses and validates relay.capabilities.yaml (schema relay.capabilities/1). */
export async function loadCapabilitiesFile(path: string): Promise<ParsedCapabilitiesFile> {
  const raw = await readFile(path, "utf8");
  const document = parseYaml(raw) as Record<string, unknown> | null;
  if (document === null || typeof document !== "object") {
    throw new Error(`capabilities file ${path} is empty or not a mapping`);
  }
  if (document.schema !== "relay.capabilities/1") {
    throw new Error(`capabilities file ${path}: unsupported schema ${String(document.schema)}`);
  }
  const capabilities = document.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new Error(`capabilities file ${path}: "capabilities" must be a list`);
  }
  const specs: CapabilitySpec[] = [];
  for (const entry of capabilities) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`capabilities file ${path}: every capability must be a mapping`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error(`capabilities file ${path}: capability.id must be a non-empty string`);
    }
    if (!isCapabilityCheckSpec(candidate.check)) {
      throw new Error(`capabilities file ${path}: capability "${candidate.id}" has no valid check`);
    }
    const spec: CapabilitySpec = {
      id: candidate.id,
      label: typeof candidate.label === "string" ? candidate.label : candidate.id,
      required: candidate.required === true,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
      check: candidate.check,
    };
    specs.push(spec);
  }
  return { schema: document.schema, specs, path };
}

function probeCommandOnPath(command: string, versionPattern: string | undefined): CapabilityProbe {
  return async () => {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 10_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      return { state: "MISSING", detail: `command "${command}" not usable on PATH` };
    }
    const version = (result.stdout ?? "").trim().split("\n")[0] ?? "";
    if (versionPattern !== undefined && !new RegExp(versionPattern).test(version)) {
      return { state: "DEGRADED", detail: `"${command}" version ${version} does not match ${versionPattern}` };
    }
    return { state: "AVAILABLE", detail: `"${command}" ${version} on PATH` };
  };
}

function probeNodeModule(moduleName: string): CapabilityProbe {
  return async () => {
    try {
      await import(/* @vite-ignore */ moduleName);
      return { state: "AVAILABLE", detail: `module ${moduleName} importable` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "MISSING", detail: `module ${moduleName} not importable: ${message.split("\n")[0]}` };
    }
  };
}

function probeHttp(url: string, secretHeaders: Record<string, string> | undefined): CapabilityProbe {
  return async () => {
    const headers: Record<string, string> = {};
    for (const [headerName, envName] of Object.entries(secretHeaders ?? {})) {
      const value = envHeaderValue(envName);
      if (value === undefined) {
        return {
          state: "DENIED",
          detail: `secret reference ${envName} for header ${headerName} is not set`,
        };
      }
      headers[headerName] = value;
    }
    try {
      const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8_000) });
      if (response.status === 401 || response.status === 403) {
        return { state: "DENIED", detail: `${url} responded ${String(response.status)}` };
      }
      if (!response.ok) {
        return { state: "DEGRADED", detail: `${url} responded ${String(response.status)}` };
      }
      return { state: "AVAILABLE", detail: `${url} responded 200` };
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
      return { state: "MISSING", detail: `${url} unreachable: ${message}` };
    }
  };
}

function probeEnvRef(envName: string): CapabilityProbe {
  return async () =>
    envNamePresent(envName)
      ? { state: "AVAILABLE", detail: `secret reference ${envName} is set` }
      : { state: "DENIED", detail: `secret reference ${envName} is not set` };
}

function probeCustom(): CapabilityProbe {
  return async () => ({ state: "MISSING", detail: "custom probe not registered from the CLI" });
}

export function buildProbe(spec: CapabilitySpec): CapabilityProbe {
  const check = spec.check;
  switch (check.kind) {
    case "command-on-path":
      return probeCommandOnPath(check.command, check.versionPattern);
    case "node-module":
      return probeNodeModule(check.module);
    case "http":
      return probeHttp(check.url, check.secretHeaders);
    case "env-ref":
      return probeEnvRef(check.env);
    case "custom":
      return probeCustom();
  }
}

export interface EvaluateFileInput {
  path: string;
}

export async function evaluateCapabilitiesFile(
  input: EvaluateFileInput,
): Promise<{ evaluation: CapabilityEvaluation; file: ParsedCapabilitiesFile }> {
  const file = await loadCapabilitiesFile(input.path);
  const probes = new Map<string, CapabilityProbe>();
  for (const spec of file.specs) probes.set(spec.id, buildProbe(spec));
  const evaluation = await evaluateCapabilities({ specs: file.specs, probes });
  return { evaluation, file };
}
