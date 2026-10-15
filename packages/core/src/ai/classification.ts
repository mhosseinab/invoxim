import { type Extraction, extractionSchema } from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";
import { aiRunIdentityKey } from "./engine";
import type {
  AiCheckpoint,
  AiResponse,
  AiRunIdentity,
  AiTextPart,
  AiUsageStore,
  ApprovedAiConfig,
} from "./types";

export type ReceiptCategory = Extraction["records"][number]["category"];
export const EMAIL_CLASSIFICATION_VERSION = "email-classification-v1";
/** Classification review reasons (K8). Type union derived from this array. */
export const EMAIL_CLASSIFICATION_REASONS = [
  "schema",
  "uncertain",
  "input-limit",
  "budget",
  "in-progress",
  "settings-changed",
  "timeout",
  "rate-limit",
  "invalid-key",
  "unsupported",
  "outage",
] as const;

export type EmailClassificationReason =
  (typeof EMAIL_CLASSIFICATION_REASONS)[number];
export type EmailClassification =
  | {
      readonly status: "classified";
      readonly isReceipt: boolean;
      readonly category: ReceiptCategory;
    }
  | {
      readonly status: "needs-review";
      readonly reason: EmailClassificationReason;
    };
/**
 * A provider rejection that is retryable or operator-scoped. It is returned to
 * the pipeline but never persisted as a completed classification.
 */
export type DeferredClassification = {
  readonly status: "deferred";
  /** `cooldown`: a durable provider cooldown blocks the call before HTTP. */
  readonly reason: "rate-limit" | "invalid-key" | "cooldown";
  /** When the job may retry; bounded to one day. */
  readonly retryAfterMs: number;
};
export interface EmailClassifier {
  classify(
    parts: readonly AiTextPart[],
    config: ApprovedAiConfig,
    signal?: AbortSignal,
  ): Promise<AiResponse>;
}
export interface ClassificationUsageStore extends Omit<
  AiUsageStore,
  "checkpoint" | "complete"
> {
  checkpoint(
    input: AiCheckpoint,
  ): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: EmailClassification }
  >;
  complete(input: AiCheckpoint, result: EmailClassification): Promise<boolean>;
  /** End of an active provider cooldown for this destination/model, if any. */
  cooldownUntil(input: AiCheckpoint): Promise<number | null>;
}
export function validateEmailClassification(
  value: unknown,
): EmailClassification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.status === "classified" &&
    Object.keys(row).length === 3 &&
    typeof row.isReceipt === "boolean"
  ) {
    const category =
      extractionSchema.shape.records.element.shape.category.safeParse(
        row.category,
      );
    return category.success
      ? {
          status: "classified",
          isReceipt: row.isReceipt,
          category: category.data,
        }
      : null;
  }
  return row.status === "needs-review" &&
    Object.keys(row).length === 2 &&
    (EMAIL_CLASSIFICATION_REASONS as readonly string[]).includes(
      typeof row.reason === "string" ? row.reason : "",
    )
    ? (row as unknown as EmailClassification)
    : null;
}
export function createClassificationEngine(dependencies: {
  classifier: EmailClassifier;
  store: ClassificationUsageStore;
}) {
  return {
    async classify(
      tenant: TenantContext,
      identity: AiRunIdentity,
      parts: readonly AiTextPart[],
      config: ApprovedAiConfig,
      signal?: AbortSignal,
      /**
       * True on the job's last permitted lease: a provider rejection then
       * becomes a persisted, reviewable outcome instead of another deferral.
       * Rejection retries are therefore bounded by the job retry policy.
       */
      options: { readonly finalAttempt?: boolean } = {},
    ): Promise<EmailClassification | DeferredClassification> {
      if (
        config.promptVersion !== EMAIL_CLASSIFICATION_VERSION ||
        ![1, 2].includes(config.maxAttempts) ||
        parts.length === 0 ||
        parts.length > 64 ||
        parts.some((part) => !part.text.trim()) ||
        parts.reduce(
          (sum, part) => sum + new TextEncoder().encode(part.text).length,
          0,
        ) > config.maxInputBytes
      )
        return { status: "needs-review", reason: "input-limit" };
      const checkpoint = { tenant, identity, config };
      const state = await dependencies.store.checkpoint(checkpoint);
      if (state.status === "completed") return state.result;
      if (state.status !== "ready" || signal?.aborted)
        return { status: "needs-review", reason: "settings-changed" };
      const prefix = await aiRunIdentityKey(checkpoint);
      const { store } = dependencies;
      let result: EmailClassification | null = null;
      // `config.maxAttempts` slots bound billed calls. The meter re-arms a slot
      // whose only use was a zero-cost rejection after its cooldown ended.
      for (let number = 1; number <= config.maxAttempts && !result; number++) {
        const attempt = {
          ...checkpoint,
          attemptId: `${prefix}:${number}`,
          attemptNumber: number,
        };
        const reservation = await store.reserve(attempt);
        // A slot still holding a billed, unfinished or cooling-down attempt
        // is skipped; the meter refuses to follow an unfinished one.
        if (reservation === "existing") continue;
        if (reservation !== "reserved") {
          const until = await store.cooldownUntil(checkpoint);
          const wait = until === null ? 0 : until - Date.now();
          return wait > 0
            ? {
                status: "deferred",
                reason: "cooldown",
                retryAfterMs: Math.min(wait, 86400000),
              }
            : { status: "needs-review", reason: "budget" };
        }
        if (!(await store.authorize(attempt)))
          return { status: "needs-review", reason: "settings-changed" };
        let response: AiResponse;
        try {
          response = await dependencies.classifier.classify(
            parts,
            config,
            signal,
          );
        } catch {
          await store.settle(attempt, { state: "uncertain", usage: null });
          return { status: "needs-review", reason: "outage" };
        }
        const usage = response.usage;
        const validUsage =
          usage !== null &&
          [usage.input, usage.output, usage.other].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          );
        const exceeded =
          validUsage &&
          BigInt(usage.input) + BigInt(usage.output) + BigInt(usage.other) >
            BigInt(config.reservationUnits);
        const known = validUsage && usage.source === "reported" && !exceeded;
        const rejection =
          response.status === "failed" &&
          (response.reason === "rate-limit" ||
            response.reason === "invalid-key")
            ? response.reason
            : null;
        const floor =
          response.status === "failed" &&
          rejection &&
          response.retryAfterMs !== undefined &&
          Number.isSafeInteger(response.retryAfterMs) &&
          response.retryAfterMs >= 0
            ? response.retryAfterMs
            : undefined;
        await store.settle(attempt, {
          state: known ? "known" : "uncertain",
          usage: validUsage ? usage : null,
          ...(floor === undefined ? {} : { retryAfterMs: floor }),
        });
        if (exceeded) return { status: "needs-review", reason: "budget" };
        if (rejection && !options.finalAttempt)
          return {
            status: "deferred",
            reason: rejection,
            retryAfterMs: Math.min(floor ?? 30000, 86400000),
          };
        if (response.status === "failed")
          result = {
            status: "needs-review",
            reason:
              response.reason === "timeout" ||
              response.reason === "rate-limit" ||
              response.reason === "invalid-key" ||
              response.reason === "unsupported"
                ? response.reason
                : "outage",
          };
        else {
          let parsed: unknown;
          try {
            parsed =
              response.output.length <= config.maxOutputBytes &&
              response.finish === "complete"
                ? JSON.parse(response.output)
                : null;
          } catch {
            parsed = null;
          }
          result = validateEmailClassification(parsed) ?? {
            status: "needs-review",
            reason: "schema",
          };
        }
      }
      if (!result) return { status: "needs-review", reason: "in-progress" };
      return (await dependencies.store.complete(checkpoint, result))
        ? result
        : { status: "needs-review", reason: "settings-changed" };
    },
  };
}
