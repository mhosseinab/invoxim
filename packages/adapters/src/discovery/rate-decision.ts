/**
 * G4: the one provider rate-limit policy for Gmail and Outlook discovery.
 *
 * A Retry-After longer than a day (or unusable) pauses rate service instead of
 * being shortened, and the fifth consecutive rate limit pauses rather than
 * deferring forever. `consecutive_failures` is capped at 5 by the schema.
 */
export const RATE_DEFAULT_RETRY_AFTER_MS = 30_000;
export const RATE_MIN_DEFER_MS = 1_000;
export const RATE_MAX_DEFER_MS = 86_400_000;
export const RATE_FAILURE_CAP = 5;

export type RateDecision =
  | { kind: "defer"; delayMs: number; failures: number }
  | { kind: "pause"; reason: "retry-after"; failures: number }
  | { kind: "pause"; reason: "failure-cap"; delayMs: number; failures: number };

/**
 * `countFailure: false` re-defers an already-counted wait (a folder whose
 * saved retry time has not arrived), so it never reaches the failure cap.
 */
export function rateDecision(input: {
  retryAfterMs?: number | undefined;
  consecutiveFailures: number;
  countFailure?: boolean;
}): RateDecision {
  const countFailure = input.countFailure ?? true;
  const requested = input.retryAfterMs ?? RATE_DEFAULT_RETRY_AFTER_MS;
  const delayMs = Number.isFinite(requested)
    ? Math.max(RATE_MIN_DEFER_MS, requested)
    : Number.POSITIVE_INFINITY;
  const failures = countFailure
    ? Math.min(RATE_FAILURE_CAP, input.consecutiveFailures + 1)
    : Math.min(RATE_FAILURE_CAP, input.consecutiveFailures);
  if (delayMs > RATE_MAX_DEFER_MS)
    return { kind: "pause", reason: "retry-after", failures };
  if (countFailure && input.consecutiveFailures + 1 >= RATE_FAILURE_CAP)
    return { kind: "pause", reason: "failure-cap", delayMs, failures };
  return { kind: "defer", delayMs, failures };
}
