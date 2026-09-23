import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  doctorExitCode,
  formatDoctorJson,
  formatDoctorReport,
  runDoctor,
  type DoctorProbeSpec,
} from "../src/index.js";

function fixedProbes(): DoctorProbeSpec[] {
  return [
    { id: "storage", label: "SQLite storage", run: async () => ({ status: "ok", detail: "injected ok" }) },
    { id: "pi", label: "Pi CLI", run: async () => ({ status: "warn", detail: "injected warn" }) },
    { id: "artifacts", label: "Artifact root", run: async () => ({ status: "ok", detail: "injected ok" }) },
  ];
}

describe("runDoctor", () => {
  it("is deterministic for injected probe inputs", async () => {
    const first = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: fixedProbes(),
    });
    const second = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: fixedProbes(),
    });
    assert.deepEqual(first, second);
  });

  it("orders checks by id and derives the worst summary", async () => {
    const result = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: fixedProbes(),
    });
    assert.deepEqual(
      result.checks.map((check) => check.id),
      ["artifacts", "pi", "storage"],
    );
    assert.equal(result.summary, "warn");
    assert.equal(result.schema, "relay.doctor/1");
  });

  it("turns a throwing probe into a fail check instead of aborting", async () => {
    const result = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: [
        {
          id: "boom",
          label: "Throwing probe",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    assert.equal(result.checks[0]?.status, "fail");
    assert.match(result.checks[0]?.detail ?? "", /probe error: boom/);
    assert.equal(result.summary, "fail");
    assert.equal(doctorExitCode(result), 2);
  });

  it("rejects duplicate probe ids", async () => {
    await assert.rejects(
      runDoctor({
        relayVersion: "0.1.0",
        context: { cwd: "/tmp/relay-test" },
        probes: [...fixedProbes(), ...fixedProbes()],
      }),
      /duplicate doctor probe id/,
    );
  });

  it("maps summary to machine-checkable exit codes", async () => {
    const ok = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "c" },
      probes: [{ id: "a", label: "A", run: async () => ({ status: "ok", detail: "" }) }],
    });
    const warn = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "c" },
      probes: [{ id: "a", label: "A", run: async () => ({ status: "warn", detail: "" }) }],
    });
    const fail = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "c" },
      probes: [{ id: "a", label: "A", run: async () => ({ status: "fail", detail: "" }) }],
    });
    assert.equal(doctorExitCode(ok), 0);
    assert.equal(doctorExitCode(warn), 1);
    assert.equal(doctorExitCode(fail), 2);
  });
});

describe("doctor formatting", () => {
  it("renders a stable human report from structured fields only", async () => {
    const result = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: fixedProbes(),
    });
    const text = formatDoctorReport(result);
    assert.match(text, /^relay doctor — relay v0\.1\.0$/m);
    assert.match(text, /^cwd: \/tmp\/relay-test$/m);
    assert.match(text, /^\[warn\] Pi CLI \(pi\): injected warn$/m);
    assert.match(text, /^summary: warn$/m);
    assert.match(text, /^exit code: 1$/m);
  });

  it("round-trips JSON output", async () => {
    const result = await runDoctor({
      relayVersion: "0.1.0",
      context: { cwd: "/tmp/relay-test" },
      probes: fixedProbes(),
    });
    assert.deepEqual(JSON.parse(formatDoctorJson(result)), result);
  });
});
