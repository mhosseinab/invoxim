import { type Extraction, extractionSchema } from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";
import { aiRunIdentityKey, settleReservedAttempt } from "./engine";
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
  readonly reason: "rate-limit" | "invalid-key";
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
      let result: EmailClassification = {
        status: "needs-review",
        reason: "schema",
      };
      for (let number = 1; number <= config.maxAttempts; number++) {
        const final = number === config.maxAttempts;
        const reserved = await settleReservedAttempt(
          dependencies.store,
          {
            ...checkpoint,
            attemptId: `${prefix}:${number}`,
            attemptNumber: number,
          },
          () => dependencies.classifier.classify(parts, config, signal),
        );
        if (reserved.status === "needs-review") {
          // An earlier lease already used this attempt for a deferred (not
          // persisted) provider rejection; the meter admits the next attempt
          // only after that one settled as known.
          if (reserved.reason === "in-progress" && !final) continue;
          return reserved;
        }
        const { response } = reserved;
        if (response.status === "failed") {
          // Operator credential rejected: never a per-document outcome.
          if (response.reason === "invalid-key")
            return { status: "deferred", reason: "invalid-key" };
          // Rate limit: retry after Retry-After, bounded by maxAttempts.
          if (response.reason === "rate-limit" && !final)
            return { status: "deferred", reason: "rate-limit" };
          result = {
            status: "needs-review",
            reason:
              response.reason === "timeout" || response.reason === "rate-limit"
                ? response.reason
                : "outage",
          };
        } else {
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
        break;
      }
      return (await dependencies.store.complete(checkpoint, result))
        ? result
        : { status: "needs-review", reason: "settings-changed" };
    },
  };
}
