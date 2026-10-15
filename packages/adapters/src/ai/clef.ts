import type { EmailClassifier } from "@invoxim/core";
import {
  CLEF_DESTINATION_ID,
  CLEF_MODEL_ID,
  CLEF_REQUEST_MODEL,
  CLEF_RESPONSE_MODELS,
} from "./clef-protocol";
import {
  createDecisionEmailClassifier,
  type DecisionClassifierOptions,
  type DecisionTransport,
} from "./decision-classifier";

export {
  type ReceiptClassificationConfiguration,
  receiptClassificationConfigurationSchema,
} from "./classification-config";
export {
  CLEF_DESTINATION_ID,
  CLEF_MODEL_ID,
  CLEF_RECEIPT_POLICY_VERSION,
} from "./clef-protocol";
export interface ClefBinding {
  run(model: string, input: unknown): Promise<unknown>;
}
/** Workers AI binding transport; the binding owns the Cloudflare endpoint. */
export function createClefTransport(binding: ClefBinding): DecisionTransport {
  return {
    destinationId: CLEF_DESTINATION_ID,
    modelId: CLEF_MODEL_ID,
    requestModel: CLEF_REQUEST_MODEL,
    responseModels: CLEF_RESPONSE_MODELS,
    async send(request, { timeoutMs, signal }) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("CLASSIFIER_TIMEOUT")),
            timeoutMs,
          );
          abortHandler = () => reject(new Error("CLASSIFIER_ABORTED"));
          signal?.addEventListener("abort", abortHandler, { once: true });
        });
        const raw = await Promise.race([
          binding.run(CLEF_MODEL_ID, request),
          cancelled,
        ]);
        return { status: "answered", raw };
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
export function createClefEmailClassifier(
  binding: ClefBinding,
  options: DecisionClassifierOptions = {},
): EmailClassifier {
  return createDecisionEmailClassifier(createClefTransport(binding), options);
}
