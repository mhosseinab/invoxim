import type { AiResponse, EmailClassifier } from "@invoxim/core";
import {
  buildDecisionRequest,
  type DecisionThresholds,
  parseDecisionResponse,
  RECEIPT_DECISION_POLICY_VERSION,
  resolveDecisionThresholds,
  routeDecisionDocument,
} from "./decision-protocol";

export type DecisionRequest = ReturnType<typeof buildDecisionRequest>;
export type DecisionFailure = Extract<AiResponse, { status: "failed" }>;
/**
 * One external decision boundary (AI-CLASSIFIER-PROVIDER). A transport only
 * delivers the fixed request to its code-owned destination and returns the raw
 * answer or a typed failure; validation and routing stay provider-neutral.
 */
export interface DecisionTransport {
  readonly destinationId: string;
  readonly modelId: string;
  /** Model name placed in the request body. */
  readonly requestModel: string;
  /** Model names the destination may echo in a valid answer. */
  readonly responseModels: readonly [string, ...string[]];
  send(
    request: DecisionRequest,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<{ status: "answered"; raw: unknown } | DecisionFailure>;
}
export interface DecisionClassifierOptions extends DecisionThresholds {
  timeoutMs?: number;
  categoryThreshold?: number;
}
export function createDecisionEmailClassifier(
  transport: DecisionTransport,
  options: DecisionClassifierOptions = {},
): EmailClassifier {
  return {
    async classify(parts, config, signal): Promise<AiResponse> {
      const input = buildDecisionRequest(parts, transport.requestModel);
      const inputBytes = new TextEncoder().encode(
        JSON.stringify(input.state),
      ).byteLength;
      if (
        config.modelId !== transport.modelId ||
        config.destinationId !== transport.destinationId ||
        signal?.aborted ||
        inputBytes > config.maxInputBytes
      )
        return { status: "failed", reason: "unsupported", usage: null };
      const sent = await transport.send(input, {
        timeoutMs: options.timeoutMs ?? 30000,
        signal,
      });
      if (sent.status !== "answered") return sent;
      const parsed = parseDecisionResponse(sent.raw, transport.responseModels);
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
        resolveDecisionThresholds(options);
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
          destinationId: transport.destinationId,
          modelId: transport.modelId,
        });
      const decision = routeDecisionDocument(parsed, options);
      console.info("ai_classification_decision", {
        policyVersion: RECEIPT_DECISION_POLICY_VERSION,
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
    },
  };
}
