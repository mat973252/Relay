/**
 * M3 capability-contract evaluation matrix (pure domain, injected probes):
 * T02 (READY), T03 (optional missing => DEGRADED, runnable), T04 (required
 * missing => BLOCKED), plus DENIED semantics.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activationExitCode,
  evaluateCapabilities,
  type CapabilityProbe,
  type CapabilitySpec,
} from "../src/index.js";

function spec(id: string, required: boolean): CapabilitySpec {
  return { id, label: id, required, check: { kind: "custom", id } };
}

function probeWith(state: CapabilityProbe extends () => Promise<infer R> ? R : never): CapabilityProbe {
  return async () => state;
}

function evaluate(
  cases: { id: string; required: boolean; state: Parameters<typeof probeWith>[0]["state"] }[],
) {
  const specs = cases.map((c) => spec(c.id, c.required));
  const probes = new Map<string, CapabilityProbe>();
  for (const c of cases) probes.set(c.id, probeWith({ state: c.state, detail: `${c.id}:${c.state}` }));
  return evaluateCapabilities({ specs, probes });
}

describe("evaluateCapabilities decision matrix", () => {
  it("all AVAILABLE -> READY (exit 0)", async () => {
    const evaluation = await evaluate([
      { id: "a", required: true, state: "AVAILABLE" },
      { id: "b", required: false, state: "AVAILABLE" },
    ]);
    assert.equal(evaluation.decision, "READY");
    assert.equal(activationExitCode(evaluation), 0);
  });

  it("optional MISSING -> DEGRADED but runnable (T03)", async () => {
    const evaluation = await evaluate([
      { id: "a", required: true, state: "AVAILABLE" },
      { id: "b", required: false, state: "MISSING" },
    ]);
    assert.equal(evaluation.decision, "DEGRADED");
    assert.equal(activationExitCode(evaluation), 1);
  });

  it("required MISSING -> BLOCKED (T04)", async () => {
    const evaluation = await evaluate([
      { id: "a", required: true, state: "MISSING" },
      { id: "b", required: false, state: "AVAILABLE" },
    ]);
    assert.equal(evaluation.decision, "BLOCKED");
    assert.equal(activationExitCode(evaluation), 2);
  });

  it("required DENIED -> BLOCKED; optional DENIED -> DEGRADED", async () => {
    assert.equal(
      (await evaluate([{ id: "a", required: true, state: "DENIED" }])).decision,
      "BLOCKED",
    );
    assert.equal(
      (await evaluate([
        { id: "a", required: true, state: "AVAILABLE" },
        { id: "s", required: false, state: "DENIED" },
      ])).decision,
      "DEGRADED",
    );
  });

  it("required DEGRADED (present but wrong version) also blocks activation", async () => {
    // Architecture invariant: required capabilities must be AVAILABLE,
    // not merely present, before activation.
    const evaluation = await evaluate([{ id: "a", required: true, state: "DEGRADED" }]);
    assert.equal(evaluation.decision, "BLOCKED");
    assert.equal(activationExitCode(evaluation), 2);
  });

  it("optional DEGRADED keeps the environment runnable", async () => {
    const evaluation = await evaluate([
      { id: "a", required: true, state: "AVAILABLE" },
      { id: "b", required: false, state: "DEGRADED" },
    ]);
    assert.equal(evaluation.decision, "DEGRADED");
  });

  it("missing probe registration is a configuration error surfaced as MISSING", async () => {
    const evaluation = await evaluateCapabilities({
      specs: [spec("a", true)],
      probes: new Map(),
    });
    assert.equal(evaluation.decision, "BLOCKED");
    assert.match(evaluation.results[0]?.detail ?? "", /no probe registered/);
  });

  it("duplicate capability ids are rejected", async () => {
    await assert.rejects(
      () =>
        evaluateCapabilities({
          specs: [spec("a", true), spec("a", false)],
          probes: new Map([["a", probeWith({ state: "AVAILABLE", detail: "" })]]),
        }),
      /duplicate capability id/,
    );
  });
});
