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
export type EmailClassification =
  | {
      readonly status: "classified";
      readonly isReceipt: boolean;
      readonly category: ReceiptCategory;
    }
  | {
      readonly status: "needs-review";
      readonly reason:
        | "schema"
        | "input-limit"
        | "budget"
        | "in-progress"
        | "settings-changed"
        | "timeout"
        | "rate-limit"
        | "outage";
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
    [
      "schema",
      "input-limit",
      "budget",
      "in-progress",
      "settings-changed",
      "timeout",
      "rate-limit",
      "outage",
    ].includes(typeof row.reason === "string" ? row.reason : "")
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
    ): Promise<EmailClassification> {
      if (
        config.promptVersion !== EMAIL_CLASSIFICATION_VERSION ||
        config.maxAttempts !== 1 ||
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
      const attempt = {
        ...checkpoint,
        attemptId: `${await aiRunIdentityKey(checkpoint)}:1`,
        attemptNumber: 1,
      };
      const reservation = await dependencies.store.reserve(attempt);
      if (reservation !== "reserved")
        return {
          status: "needs-review",
          reason: reservation === "budget" ? "budget" : "in-progress",
        };
      if (!(await dependencies.store.authorize(attempt)))
        return { status: "needs-review", reason: "settings-changed" };
      let response: AiResponse;
      try {
        response = await dependencies.classifier.classify(
          parts,
          config,
          signal,
        );
      } catch {
        await dependencies.store.settle(attempt, {
          state: "uncertain",
          usage: null,
        });
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
      await dependencies.store.settle(attempt, {
        state:
          validUsage && usage.source === "reported" && !exceeded
            ? "known"
            : "uncertain",
        usage: validUsage ? usage : null,
      });
      if (exceeded) return { status: "needs-review", reason: "budget" };
      let result: EmailClassification;
      if (response.status === "failed")
        result = {
          status: "needs-review",
          reason:
            response.reason === "timeout" || response.reason === "rate-limit"
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
      return (await dependencies.store.complete(checkpoint, result))
        ? result
        : { status: "needs-review", reason: "settings-changed" };
    },
  };
}
