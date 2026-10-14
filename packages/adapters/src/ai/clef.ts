import type { AiResponse, EmailClassifier } from "@invoxim/core";
import { z } from "zod";
import {
  buildClefRequest,
  CLEF_DESTINATION_ID,
  CLEF_MODEL_ID,
  CLEF_RECEIPT_POLICY_VERSION,
  parseClefResponse,
  resolveClefThresholds,
  routeClefDocument,
} from "./clef-protocol";
import { aiPricingSchema } from "./pricing";

export {
  CLEF_DESTINATION_ID,
  CLEF_MODEL_ID,
  CLEF_RECEIPT_POLICY_VERSION,
} from "./clef-protocol";
export const receiptClassificationConfigurationSchema = z.strictObject({
  enabled: z.boolean(),
  model: z.literal(CLEF_MODEL_ID),
  version: z.string().min(1).max(120),
  maxInputBytes: z.number().int().min(100).max(24000),
  timeoutMs: z.number().int().min(100).max(30000),
  negativeThreshold: z.number().min(0).max(0.1),
  positiveThreshold: z.number().min(0.5).max(1).optional(),
  uncertainAction: z.enum(["review", "extract"]).optional(),
  categoryThreshold: z.number().min(0.5).max(1),
  pricing: aiPricingSchema.extend({
    outputUsdMicrosPerMillion: z.literal("0"),
    otherUsdMicrosPerMillion: z.literal("0"),
  }),
});
export type ReceiptClassificationConfiguration = z.infer<
  typeof receiptClassificationConfigurationSchema
>;
export interface ClefBinding {
  run(model: string, input: unknown): Promise<unknown>;
}
export function createClefEmailClassifier(
  binding: ClefBinding,
  options: {
    timeoutMs?: number;
    negativeThreshold?: number;
    positiveThreshold?: number | undefined;
    categoryThreshold?: number;
  } = {},
): EmailClassifier {
  return {
    async classify(parts, config, signal): Promise<AiResponse> {
      const input = buildClefRequest(parts);
      const inputBytes = new TextEncoder().encode(
        JSON.stringify(input.state),
      ).byteLength;
      if (
        config.modelId !== CLEF_MODEL_ID ||
        signal?.aborted ||
        inputBytes > config.maxInputBytes
      )
        return { status: "failed", reason: "unsupported", usage: null };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("CLASSIFIER_TIMEOUT")),
            options.timeoutMs ?? 30000,
          );
          abortHandler = () => reject(new Error("CLASSIFIER_ABORTED"));
          signal?.addEventListener("abort", abortHandler, { once: true });
        });
        const raw = await Promise.race([
          binding.run(config.modelId, input),
          cancelled,
        ]);
        const parsed = parseClefResponse(raw);
        if (!parsed)
          return {
            status: "ok",
            output: JSON.stringify({
              status: "needs-review",
              reason: "schema",
            }),
            finish: "complete",
            usage: null,
          };
        const answer = parsed.answers.category;
        const chosenProbability = answer.probabilities[answer.choice] ?? 0;
        const receiptProbability = parsed.answers.receipt.noul;
        const { negativeThreshold, positiveThreshold } =
          resolveClefThresholds(options);
        const usage = parsed.usage
          ? {
              input: parsed.usage.input_tokens,
              output: parsed.usage.output_tokens,
              other: 0,
              source: "reported" as const,
            }
          : null;
        if (!usage)
          console.warn("ai_usage_unavailable", {
            destinationId: CLEF_DESTINATION_ID,
            modelId: CLEF_MODEL_ID,
          });
        const decision = routeClefDocument(parsed, options);
        console.info("ai_classification_decision", {
          policyVersion: CLEF_RECEIPT_POLICY_VERSION,
          partCount: parts.length,
          inputBytes,
          receiptProbability,
          negativeThreshold,
          positiveThreshold,
          outcome: decision.outcome,
        });
        return {
          status: "ok",
          output: JSON.stringify(
            decision.outcome === "uncertain"
              ? { status: "needs-review", reason: "uncertain" }
              : {
                  status: "classified",
                  isReceipt: decision.isReceipt,
                  category:
                    chosenProbability >= (options.categoryThreshold ?? 0.5)
                      ? answer.choice
                      : "uncategorized",
                },
          ),
          finish: "complete",
          usage,
        };
      } catch {
        return {
          status: "failed",
          reason: signal?.aborted ? "timeout" : "outage",
          usage: null,
        };
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      }
    },
  };
}
