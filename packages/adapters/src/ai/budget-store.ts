import type {
  AiAttemptIdentity,
  AiCheckpoint,
  AiUsageStore,
  ApprovedAiConfig,
  ClassificationUsageStore,
  EmailClassification,
  PersistableAiResult,
} from "@invoxim/core";
import {
  validateEmailClassification,
  validatePersistableAiResult,
} from "@invoxim/core";
import { attemptId, budgetOperation } from "./budget-helpers";
import { createMeter } from "./budget-meter";
import type {
  AiBudgetOptions,
  AiProbeBudgetOptions,
  AiProbeResult,
  AiProbeUsageStore,
  BudgetOwner,
  ClassificationBudgetOptions,
  MeterOptions,
  RunInput,
  Settlement,
} from "./budget-types";

/** Probe results are shape-checked, not rebuilt (AI-7). */
function validateProbe(value: unknown): AiProbeResult | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return row.status === "passed"
    ? Object.keys(row).length === 1
      ? (value as AiProbeResult)
      : null
    : row.status === "failed" &&
        Object.keys(row).length === 2 &&
        [
          "timeout",
          "rate-limit",
          "invalid-key",
          "unsupported",
          "refusal",
          "outage",
          "schema",
          "incomplete",
        ].includes(String(row.reason))
      ? (value as AiProbeResult)
      : null;
}

type StoreInput = AiCheckpoint | { readonly config: ApprovedAiConfig };
type StoreAttempt = AiAttemptIdentity | { readonly config: ApprovedAiConfig };

export type UsageStore<T> = {
  checkpoint(
    input: StoreInput,
  ): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: T }
  >;
  reserve(input: StoreAttempt): Promise<"reserved" | "budget" | "existing">;
  authorize(input: StoreAttempt): Promise<boolean>;
  settle(input: StoreAttempt, settlement: Settlement): Promise<void>;
  complete(input: StoreInput, value: unknown): Promise<boolean>;
};

/**
 * One usage-store factory (AI-7): `owner` selects the admission path,
 * `validate` bounds persisted results, `wrap` maps infrastructure failures.
 * Extraction and classification inputs re-verify their claimed attempt id
 * against the recomputed run key; synthetic probes have no such claim.
 */
export function createUsageStore<T>(params: {
  db: D1Database;
  owner: BudgetOwner;
  options: MeterOptions;
  validate: (value: unknown) => T | null;
  wrap: <R>(operation: () => Promise<R>) => Promise<R>;
}): UsageStore<T> {
  const meter = createMeter(params.db, params.owner, params.options);
  const { validate, wrap } = params;
  function toRun(input: StoreInput): Promise<RunInput> {
    return "identity" in input
      ? meter.normal(input)
      : meter.probe(input.config);
  }
  /** Single attemptId rule (was 6 copies): claim must equal `runKey:attemptNumber`. */
  async function toAttemptRun(input: StoreAttempt): Promise<RunInput | null> {
    if (!("identity" in input)) return meter.probe(input.config);
    const run = await meter.normal(input, input.attemptNumber);
    return input.attemptId === attemptId(run.runKey, input.attemptNumber)
      ? run
      : null;
  }
  return {
    checkpoint: (input) =>
      wrap(async () => {
        const state = await meter.checkpoint(await toRun(input));
        if (state.status !== "completed") return state;
        const result = validate(state.result);
        return result
          ? { status: "completed" as const, result }
          : { status: "stale" as const };
      }),
    reserve: (input) =>
      wrap(async () => {
        const run = await toAttemptRun(input);
        return run ? meter.reserve(run) : ("budget" as const);
      }),
    authorize: (input) =>
      wrap(async () => {
        const run = await toAttemptRun(input);
        return run !== null && meter.authorize(run);
      }),
    settle: (input, settlement) =>
      wrap(async () => {
        const run = await toAttemptRun(input);
        if (run) await meter.settle(run, settlement);
      }),
    complete: (input, value) =>
      wrap(async () => {
        const result = validate(value);
        return result !== null && meter.complete(await toRun(input), result);
      }),
  };
}

export function createAiUsageStore(
  db: D1Database,
  options: AiBudgetOptions,
): AiUsageStore {
  return createUsageStore<PersistableAiResult>({
    db,
    owner: { kind: "extraction", lease: options.lease },
    options,
    validate: validatePersistableAiResult,
    wrap: budgetOperation,
  });
}

export function createClassificationUsageStore(
  db: D1Database,
  options: ClassificationBudgetOptions,
): ClassificationUsageStore {
  return createUsageStore<EmailClassification>({
    db,
    owner: { kind: "extraction", lease: options.lease },
    options: { ...options, classificationAuthorization: options.authorization },
    validate: validateEmailClassification,
    wrap: budgetOperation,
  });
}

export function createAiProbeUsageStore(
  db: D1Database,
  options: AiProbeBudgetOptions,
): AiProbeUsageStore {
  return createUsageStore<AiProbeResult>({
    db,
    owner: { kind: "synthetic-test", session: options.session },
    options,
    validate: validateProbe,
    wrap: budgetOperation,
  });
}
