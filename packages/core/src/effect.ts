/**
 * @relay/core — External Effect Guard domain (M1).
 *
 * Pure orchestration over an injected durable journal. No filesystem,
 * network, process, or Pi assumptions live here. The single invariant this
 * module exists to enforce:
 *
 *   A non-replayable unsafe external effect must never be silently
 *   duplicated across crashes/restarts; when remote truth is unknowable,
 *   the record stays UNKNOWN and automatic replay stops.
 */
import { createHash, randomUUID } from "node:crypto";

export type EffectStatus = "PREPARED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN";

/** v0.1 supports only non-replayable effects; the field makes the contract explicit. */
export type ReplayPolicy = "never";

/** Points inside the runner where a crash can be injected (test/diagnostic seam). */
export type RunnerCrashPoint =
  | "before-prepared-commit"
  | "after-prepared-commit"
  | "before-execute"
  | "after-execute-before-confirm"
  | "after-confirm";

/** Crash points that occur while the request is in flight (provider-side seam). */
export type InFlightCrashPoint = "after-send" | "after-remote-commit";

export type CrashPoint = RunnerCrashPoint | InFlightCrashPoint;

export interface EffectRecord {
  /** Opaque unique id (uuid v4). */
  id: string;
  /** Semantic idempotency key: one logical operation == one key. */
  key: string;
  /** Provider/class of the external effect, e.g. "http-counter/increment". */
  kind: string;
  /** SHA-256 of the canonicalized request; equal requests hash equally. */
  requestHash: string;
  /**
   * Optional serialized non-secret intent description (recovery metadata so
   * a fresh session can recognize the operation). NOT identity: excluded
   * from requestHash on purpose — re-entry must not depend on prose.
   */
  intentJson?: string | undefined;
  replay: ReplayPolicy;
  status: EffectStatus;
  /** Provider-side reference for the committed effect, when known. */
  remoteRef: string | undefined;
  /** Serialized (JSON) confirmed result payload, when confirmed. */
  resultJson: string | undefined;
  /** Reason for the last FAILED/UNKNOWN transition (reconcile evidence). */
  reason: string | undefined;
  createdAt: number;
  submittedAt: number | undefined;
  settledAt: number | undefined;
  updatedAt: number;
}

/**
 * Why a latest-state transition was committed. `unknown` is the explicit
 * label for callers that did not say — it is never inferred.
 */
export type EffectTransitionCause = "prepare" | "submit" | "execute" | "reconcile" | "unknown";

/** One committed latest-state transition (or a repeated UNKNOWN reconcile observation). */
export interface EffectTransitionEvent {
  /** Journal-wide append order; unique and monotonic within one journal. */
  seq: number;
  effectId: string;
  key: string;
  kind: string;
  /** undefined for the initial PREPARED insert. */
  fromStatus: EffectStatus | undefined;
  toStatus: EffectStatus;
  cause: EffectTransitionCause;
  reason: string | undefined;
  remoteRef: string | undefined;
  at: number;
}

/**
 * observed    — every transition of this record since its insert is recorded.
 * partial     — the record predates the event table; only later transitions exist.
 * unavailable — no events at all (legacy row or snapshot-only import).
 */
export type EffectHistoryCoverage = "observed" | "partial" | "unavailable";

export interface EffectHistory {
  /** Latest-state row: the execution authority. */
  record: EffectRecord;
  events: EffectTransitionEvent[];
  coverage: EffectHistoryCoverage;
}

/** Durable journal port. Implementations must survive process death (fsync-grade commits). */
export interface EffectJournal {
  insertPrepared(record: EffectRecord): Promise<void>;
  markSubmitted(id: string, at: number, cause?: EffectTransitionCause): Promise<void>;
  markConfirmed(
    id: string,
    patch: {
      remoteRef: string | undefined;
      resultJson: string | undefined;
      at: number;
      cause?: EffectTransitionCause;
    },
  ): Promise<void>;
  markFailed(id: string, reason: string, at: number, cause?: EffectTransitionCause): Promise<void>;
  markUnknown(id: string, reason: string, at: number, cause?: EffectTransitionCause): Promise<void>;
  get(id: string): Promise<EffectRecord | undefined>;
  getByKey(key: string): Promise<EffectRecord | undefined>;
  list(): Promise<EffectRecord[]>;
}

/** Optional read-only evidence port; journals without history simply do not implement it. */
export interface EffectHistoryReader {
  listEvents(effectId?: string): Promise<EffectTransitionEvent[]>;
  listHistory(key?: string): Promise<EffectHistory[]>;
}

const STATUSES: readonly EffectStatus[] = ["PREPARED", "SUBMITTED", "CONFIRMED", "FAILED", "UNKNOWN"];
const CAUSES: readonly EffectTransitionCause[] = ["prepare", "submit", "execute", "reconcile", "unknown"];

export function isEffectStatus(value: unknown): value is EffectStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isEffectTransitionCause(value: unknown): value is EffectTransitionCause {
  return typeof value === "string" && (CAUSES as readonly string[]).includes(value);
}

/**
 * Structural check of a single event (no cross-record semantics).
 * Returns an error message or undefined.
 */
export function validateEffectTransitionEvent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "event is not an object";
  const e = value as Record<string, unknown>;
  if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 1) return "seq invalid";
  if (typeof e.effectId !== "string" || e.effectId.length === 0) return "effectId invalid";
  if (typeof e.key !== "string" || e.key.length === 0) return "key invalid";
  if (typeof e.kind !== "string") return "kind invalid";
  if (e.fromStatus !== undefined && e.fromStatus !== null && !isEffectStatus(e.fromStatus)) return "fromStatus invalid";
  if (!isEffectStatus(e.toStatus)) return "toStatus invalid";
  if (!isEffectTransitionCause(e.cause)) return "cause invalid";
  if (e.reason !== undefined && e.reason !== null && typeof e.reason !== "string") return "reason invalid";
  if (e.remoteRef !== undefined && e.remoteRef !== null && typeof e.remoteRef !== "string") return "remoteRef invalid";
  if (typeof e.at !== "number") return "at invalid";
  return undefined;
}

/**
 * Cross-checks an event stream against the latest-state rows it claims to
 * describe. Events are evidence, never authority: any contradiction is an
 * error rather than a reason to change a row. Rules:
 *  - every event references a known record (same key/kind);
 *  - seq values are unique;
 *  - per record, events chain (event[i].fromStatus === event[i-1].toStatus);
 *  - a record's first event, if it starts from nothing, is PREPARED/prepare;
 *  - a record that has events ends at the record's current status.
 * Returns an error message or undefined.
 */
export function validateEffectEvidence(
  records: readonly EffectRecord[],
  events: readonly EffectTransitionEvent[],
): string | undefined {
  const byId = new Map(records.map((r) => [r.id, r]));
  const seqs = new Set<number>();
  const perRecord = new Map<string, EffectTransitionEvent[]>();
  for (const event of events) {
    const structural = validateEffectTransitionEvent(event);
    if (structural !== undefined) return `effect evidence invalid: ${structural}`;
    if (seqs.has(event.seq)) return `effect evidence invalid: duplicate seq ${String(event.seq)}`;
    seqs.add(event.seq);
    const record = byId.get(event.effectId);
    if (record === undefined) return `effect evidence orphan: effect ${event.effectId} has no latest-state row`;
    if (record.key !== event.key || record.kind !== event.kind) {
      return `effect evidence contradicts record identity for ${event.effectId}`;
    }
    const list = perRecord.get(event.effectId) ?? [];
    list.push(event);
    perRecord.set(event.effectId, list);
  }
  for (const [id, list] of perRecord) {
    list.sort((a, b) => a.seq - b.seq);
    const record = byId.get(id)!;
    for (let i = 0; i < list.length; i += 1) {
      const event = list[i]!;
      if (i === 0) {
        if (event.fromStatus === undefined && (event.toStatus !== "PREPARED" || event.cause !== "prepare")) {
          return `effect evidence invalid: first event of ${id} is not a prepare`;
        }
      } else if (event.fromStatus !== list[i - 1]!.toStatus) {
        return `effect evidence invalid: broken chain for ${id} at seq ${String(event.seq)}`;
      }
    }
    const last = list[list.length - 1]!;
    if (last.toStatus !== record.status) {
      return `effect evidence contradicts latest state for ${id}: last event ${last.toStatus}, row ${record.status}`;
    }
  }
  return undefined;
}

/**
 * Read-only reconciliation contract (observation, never replay).
 *
 * - found: true  — the provider PROVES the effect executed (CONFIRMED).
 * - found: false — the provider PROVES the effect never executed (FAILED).
 *   Only to be returned on contract-backed proof of non-execution; a
 *   "pending"/unknown/ambiguous remote answer is NOT such proof.
 * - found: "uncertain" — neither is proven; the record stays UNKNOWN.
 */
export type ReconcileOutcome =
  | { found: true; remoteRef: string | undefined; result: unknown }
  | { found: false }
  | { found: "uncertain"; reason: string };

export interface EffectExecuteContext {
  record: EffectRecord;
}

/**
 * Thrown by `execute` when the request may or may not have been committed
 * remotely (timeout, connection reset after send, ...). Maps to UNKNOWN.
 */
export class AmbiguousEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousEffectError";
  }
}

/** Thrown on re-entry against an unsettled record when no reconcile is supplied. */
export class EffectNeedsReconciliationError extends Error {
  readonly record: EffectRecord;

  constructor(record: EffectRecord) {
    super(
      `effect "${record.key}" is ${record.status}; remote truth is not established and no reconcile was supplied — automatic replay is disabled`,
    );
    this.name = "EffectNeedsReconciliationError";
    this.record = record;
  }
}

/**
 * Test/diagnostic crash signal. The runner never catches it; callers treat
 * it as equivalent to process death (all in-memory state is lost, the
 * journal keeps whatever was committed before the throw).
 */
export class SimulatedProcessDeath extends Error {
  readonly point: CrashPoint;

  constructor(point: CrashPoint) {
    super(`simulated process death at ${point}`);
    this.name = "SimulatedProcessDeath";
    this.point = point;
  }
}

export type EffectOutcome =
  | {
      status: "confirmed";
      key: string;
      remoteRef: string | undefined;
      result: unknown;
      /** true when a CONFIRMED record was reused without re-executing. */
      deduplicated: boolean;
      /** true when confirmation came from reconciliation, not execution. */
      reconciled: boolean;
    }
  | { status: "failed"; key: string; reason: string; reconciled: boolean }
  | { status: "unknown"; key: string; reason: string };

export interface CrashInjection {
  point: CrashPoint;
  /** Must never return normally (throw SimulatedProcessDeath or kill the process). */
  kill: (point: CrashPoint) => void;
}

export interface RunEffectInput {
  key: string;
  kind: string;
  /** JSON-serializable request description; hashed for the record. */
  request: unknown;
  /** Non-secret intent description stored on the record (not hashed). */
  intent?: string | undefined;
  replay: ReplayPolicy;
  /** Performs the unsafe external operation. Must throw AmbiguousEffectError on uncertainty. */
  execute: (ctx: EffectExecuteContext) => Promise<unknown>;
  /** Optional reconciliation for unsettled records on re-entry. */
  reconcile?: (record: EffectRecord) => Promise<ReconcileOutcome>;
  journal: EffectJournal;
  /** Injectable clock (epoch ms) for determinism. */
  now?: () => number;
  /** Crash-injection seam. */
  crash?: CrashInjection;
}

/** Deterministic JSON canonicalization: recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashRequest(request: unknown): string {
  return createHash("sha256").update(stableStringify(request), "utf8").digest("hex");
}

function maybeCrash(input: RunEffectInput, point: RunnerCrashPoint): void {
  if (input.crash !== undefined && input.crash.point === point) {
    input.crash.kill(point);
  }
}

function parseResult(record: EffectRecord): unknown {
  return record.resultJson === undefined ? undefined : (JSON.parse(record.resultJson) as unknown);
}

function confirmedOutcome(
  record: EffectRecord,
  deduplicated: boolean,
  reconciled: boolean,
): EffectOutcome {
  return {
    status: "confirmed",
    key: record.key,
    remoteRef: record.remoteRef,
    result: parseResult(record),
    deduplicated,
    reconciled,
  };
}

/**
 * The `relay.effect({...})` semantic contract.
 *
 * Fresh path:  PREPARED -> SUBMITTED -> execute -> CONFIRMED | FAILED | UNKNOWN.
 * Re-entry:
 *   - CONFIRMED            -> deduplicated confirmed result (no execution).
 *   - PREPARED             -> execution never began; resume by executing (safe continuation).
 *   - SUBMITTED | UNKNOWN  -> reconcile required: proven execution -> CONFIRMED,
 *                             proven non-execution -> FAILED (operator re-issues;
 *                             no auto replay), uncertain -> stays UNKNOWN.
 *   - FAILED               -> terminal; returns the failure (operator decides).
 */
export async function runEffect(input: RunEffectInput): Promise<EffectOutcome> {
  if (input.replay !== "never") {
    throw new Error(`unsupported replay policy: ${String(input.replay)} (v0.1 supports "never" only)`);
  }
  const now = input.now ?? (() => Date.now());
  const journal = input.journal;

  const existing = await journal.getByKey(input.key);
  if (
    existing !== undefined &&
    (existing.kind !== input.kind || existing.requestHash !== hashRequest(input.request) || existing.replay !== input.replay)
  ) {
    throw new Error(`semantic key ${input.key} refers to a different effect`);
  }

  if (existing !== undefined && existing.status === "CONFIRMED") {
    return confirmedOutcome(existing, true, false);
  }
  if (existing !== undefined && existing.status === "FAILED") {
    return { status: "failed", key: existing.key, reason: existing.reason ?? "failed", reconciled: false };
  }

  let record: EffectRecord;
  if (existing !== undefined) {
    record = existing;
    if (record.status === "PREPARED") {
      // Execution never began (PREPARED is committed before execute is invoked):
      // continuing the state machine is a safe continuation, not a replay.
    } else if (record.status === "SUBMITTED" || record.status === "UNKNOWN") {
      if (input.reconcile === undefined) {
        throw new EffectNeedsReconciliationError(record);
      }
      const outcome = await input.reconcile(record);
      if (outcome.found === true) {
        const resultJson = JSON.stringify(outcome.result ?? null);
        await journal.markConfirmed(record.id, {
          remoteRef: outcome.remoteRef,
          resultJson,
          at: now(),
          cause: "reconcile",
        });
        const settled = await journal.get(record.id);
        return settled === undefined
          ? { status: "unknown", key: record.key, reason: "journal lost confirmed record" }
          : confirmedOutcome(settled, false, true);
      }
      if (outcome.found === false) {
        const reason = `reconcile: remote has no record of effect; replay=${record.replay} forbids automatic re-execution`;
        await journal.markFailed(record.id, reason, now(), "reconcile");
        return { status: "failed", key: record.key, reason, reconciled: true };
      }
      const reason = `reconcile uncertain: ${outcome.reason}`;
      await journal.markUnknown(record.id, reason, now(), "reconcile");
      return { status: "unknown", key: record.key, reason };
    } else {
      throw new Error(`unhandled effect status: ${String((record as { status: string }).status)}`);
    }
  } else {
    maybeCrash(input, "before-prepared-commit");
    record = {
      id: randomUUID(),
      key: input.key,
      kind: input.kind,
      requestHash: hashRequest(input.request),
      intentJson: input.intent,
      replay: input.replay,
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: now(),
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: now(),
    };
    await journal.insertPrepared(record);
    maybeCrash(input, "after-prepared-commit");
  }

  await journal.markSubmitted(record.id, now(), "submit");
  maybeCrash(input, "before-execute");

  let result: unknown;
  try {
    result = await input.execute({ record });
  } catch (err) {
    if (err instanceof SimulatedProcessDeath) throw err;
    if (err instanceof AmbiguousEffectError) {
      await journal.markUnknown(record.id, `ambiguous: ${err.message}`, now(), "execute");
      return { status: "unknown", key: record.key, reason: `ambiguous: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    await journal.markFailed(record.id, `failed: ${message}`, now(), "execute");
    return { status: "failed", key: record.key, reason: `failed: ${message}`, reconciled: false };
  }

  let resultJson: string;
  try {
    resultJson = JSON.stringify(result ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await journal.markFailed(record.id, `result not serializable: ${message}`, now(), "execute");
    return {
      status: "failed",
      key: record.key,
      reason: `result not serializable: ${message}`,
      reconciled: false,
    };
  }

  const remoteRef =
    typeof result === "object" && result !== null && "remoteRef" in result
      ? String((result as { remoteRef: unknown }).remoteRef)
      : undefined;

  maybeCrash(input, "after-execute-before-confirm");
  await journal.markConfirmed(record.id, { remoteRef, resultJson, at: now(), cause: "execute" });
  maybeCrash(input, "after-confirm");

  const settled = await journal.get(record.id);
  return settled === undefined
    ? { status: "unknown", key: record.key, reason: "journal lost confirmed record" }
    : confirmedOutcome(settled, false, false);
}
