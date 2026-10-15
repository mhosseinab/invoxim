import {
  buildDecisionRequest,
  type DecisionAnswer,
  type DecisionThresholds,
  parseDecisionResponse,
  RECEIPT_DECISION_POLICY_VERSION,
  resolveDecisionThresholds,
  routeDecisionDocument,
  routeDecisionReceipt,
} from "./decision-protocol";

/**
 * Cloudflare Workers AI Clef identity over the provider-neutral decision
 * protocol. Kept as a facade so the Clef evaluation tool and existing imports
 * keep one source for Clef model ids (A4).
 */
export const CLEF_RECEIPT_POLICY_VERSION = RECEIPT_DECISION_POLICY_VERSION;
export const CLEF_MODEL_ID = "@cf/cloudflare/clef";
export const CLEF_REQUEST_MODEL = "clef";
export const CLEF_DESTINATION_ID = "cloudflare-clef";
export {
  DEFAULT_NEGATIVE_THRESHOLD,
  DEFAULT_POSITIVE_THRESHOLD,
} from "./decision-protocol";
export const CLEF_RESPONSE_MODELS = [
  CLEF_REQUEST_MODEL,
  CLEF_MODEL_ID,
] as const;
export function resolveClefThresholds(options: DecisionThresholds = {}) {
  return resolveDecisionThresholds(options);
}
export function parseClefResponse(raw: unknown) {
  return parseDecisionResponse(raw, CLEF_RESPONSE_MODELS);
}
export function buildClefRequest(
  parts: readonly { id: string; text: string }[],
) {
  return buildDecisionRequest(parts, CLEF_REQUEST_MODEL);
}
export function routeClefReceipt(
  probability: number,
  options: DecisionThresholds = {},
) {
  return routeDecisionReceipt(probability, options);
}
export function routeClefDocument(
  answer: DecisionAnswer,
  options: DecisionThresholds = {},
) {
  return routeDecisionDocument(answer, options);
}
