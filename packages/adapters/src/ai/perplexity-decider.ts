import { hasControlCharacters } from "@invoxim/contracts";
import type { EmailClassifier } from "@invoxim/core";
import {
  BoundedJsonError,
  parseRetryAfter,
  readJsonResponseBody,
} from "../http";
import {
  createDecisionEmailClassifier,
  type DecisionClassifierOptions,
  type DecisionFailure,
  type DecisionTransport,
} from "./decision-classifier";

/**
 * Perplexity Decisions API transport (AI-CLASSIFIER-PROVIDER). The endpoint is
 * code-owned (rule 03); configuration selects only one of the published model
 * ids. Source: https://docs.perplexity.ai/docs/decisions/quickstart (checked
 * 2026-10-15; no live invocation is implied by the synthetic tests).
 */
export const PERPLEXITY_DECISIONS_ENDPOINT =
  "https://api.perplexity.ai/v1/decisions";
export const PERPLEXITY_DESTINATION_ID = "perplexity-decider";
export const PERPLEXITY_DECIDER_MODELS = [
  "pplx-decider-v1.1-27b",
  "pplx-decider-v1-27b",
] as const;
export type PerplexityDeciderModel = (typeof PERPLEXITY_DECIDER_MODELS)[number];
/** A three-question decision answer is a few KiB; anything larger is refused. */
export const PERPLEXITY_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT_MS = 30000;
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Blank, oversized or control-character keys are not a usable credential. */
export function usablePerplexityApiKey(key: string | undefined): key is string {
  return (
    typeof key === "string" &&
    key.trim().length > 0 &&
    key.length <= 4096 &&
    !hasControlCharacters(key) &&
    !/\s/.test(key)
  );
}
const failed = (reason: DecisionFailure["reason"]): DecisionFailure => ({
  status: "failed",
  reason,
  usage: null,
});
/**
 * 401/403/429 are rejected before any decision is computed, so they settle as
 * zero reported usage (releasing the reservation) instead of an uncertain
 * possibly-billed attempt. 5xx, timeouts and unreadable bodies stay uncertain.
 */
const NOT_PROCESSED = {
  input: 0,
  output: 0,
  other: 0,
  source: "reported",
} as const;
/** A rejected operator key is retried at most this often across all tenants. */
export const PERPLEXITY_INVALID_KEY_COOLDOWN_MS = 15 * 60 * 1000;
function statusFailure(response: Response): DecisionFailure | null {
  const { status } = response;
  // Only 401 means the operator credential was rejected: shared cooldown.
  if (status === 401)
    return {
      status: "failed",
      reason: "invalid-key",
      usage: NOT_PROCESSED,
      retryAfterMs: PERPLEXITY_INVALID_KEY_COOLDOWN_MS,
    };
  // A 403 may come from an edge layer reacting to this request's content, so
  // it is a per-document unsupported outcome with no global cooldown.
  if (status === 403)
    return { status: "failed", reason: "unsupported", usage: NOT_PROCESSED };
  if (status === 429)
    return {
      status: "failed",
      reason: "rate-limit",
      usage: NOT_PROCESSED,
      retryAfterMs:
        parseRetryAfter(response.headers.get("retry-after")) ??
        DEFAULT_RATE_LIMIT_MS,
    };
  if ([400, 404, 405, 413, 422].includes(status)) return failed("unsupported");
  // 3xx (redirect: "manual"), 5xx and any other non-2xx: transient outage.
  return status >= 200 && status < 300 ? null : failed("outage");
}

export function createPerplexityTransport(
  apiKey: string,
  model: PerplexityDeciderModel,
): DecisionTransport {
  return {
    destinationId: PERPLEXITY_DESTINATION_ID,
    modelId: model,
    requestModel: model,
    responseModels: [model],
    async send(request, { timeoutMs, signal }) {
      if (!usablePerplexityApiKey(apiKey)) return failed("invalid-key");
      const controller = new AbortController();
      const deadline = Date.now() + timeoutMs;
      let reject: (error: Error) => void = () => undefined;
      const stopped = new Promise<never>((_, fail) => {
        reject = fail;
      });
      stopped.catch(() => undefined);
      const stop = () => {
        controller.abort();
        reject(new Error("CLASSIFIER_ABORTED"));
      };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        // The race covers a fetch implementation that ignores its signal.
        const response = await Promise.race([
          fetch(PERPLEXITY_DECISIONS_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(request),
            redirect: "manual",
            signal: controller.signal,
          }),
          stopped,
        ]);
        const failure = statusFailure(response);
        if (failure) {
          // Status and a UUID request id only; provider bodies may echo content.
          const requestId = response.headers.get("x-request-id");
          console.warn("ai_classification_provider_failure", {
            destinationId: PERPLEXITY_DESTINATION_ID,
            status: response.status,
            ...(requestId && REQUEST_ID.test(requestId) ? { requestId } : {}),
          });
          void response.body?.cancel().catch(() => undefined);
          return failure;
        }
        const raw = await Promise.race([
          readJsonResponseBody(response, PERPLEXITY_MAX_RESPONSE_BYTES, {
            signal: controller.signal,
            deadline,
          }),
          stopped,
        ]);
        return { status: "answered", raw };
      } catch (error) {
        const aborted =
          controller.signal.aborted ||
          (error instanceof BoundedJsonError && error.reason === "aborted");
        return failed(aborted ? "timeout" : "outage");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    },
  };
}
export function createPerplexityEmailClassifier(
  apiKey: string,
  model: PerplexityDeciderModel,
  options: DecisionClassifierOptions = {},
): EmailClassifier {
  return createDecisionEmailClassifier(
    createPerplexityTransport(apiKey, model),
    options,
  );
}
