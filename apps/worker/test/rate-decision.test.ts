import { expect, it } from "vitest";
import {
  RATE_FAILURE_CAP,
  RATE_MAX_DEFER_MS,
  rateDecision,
} from "../../../packages/adapters/src/discovery/rate-decision";

/**
 * INT-5/G4: the one rate policy shared by Gmail pages.ts and Outlook
 * outlook-delta.ts / outlook-state.ts. These pin the thresholds each copy
 * used before it was unified.
 */
it("defers with the provider delay, floored to one second, and counts the failure", () => {
  expect(
    rateDecision({ retryAfterMs: 60_000, consecutiveFailures: 0 }),
  ).toEqual({ kind: "defer", delayMs: 60_000, failures: 1 });
  expect(rateDecision({ retryAfterMs: 0, consecutiveFailures: 2 })).toEqual({
    kind: "defer",
    delayMs: 1_000,
    failures: 3,
  });
  expect(rateDecision({ consecutiveFailures: 0 })).toEqual({
    kind: "defer",
    delayMs: 30_000,
    failures: 1,
  });
});

it("pauses instead of shortening an over-day or unusable Retry-After", () => {
  for (const retryAfterMs of [
    RATE_MAX_DEFER_MS + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])
    expect(rateDecision({ retryAfterMs, consecutiveFailures: 0 })).toEqual({
      kind: "pause",
      reason: "retry-after",
      failures: 1,
    });
  expect(
    rateDecision({ retryAfterMs: RATE_MAX_DEFER_MS, consecutiveFailures: 0 }),
  ).toMatchObject({ kind: "defer", delayMs: RATE_MAX_DEFER_MS });
});

it("pauses on the fifth consecutive rate limit and never exceeds the schema cap", () => {
  expect(
    rateDecision({ retryAfterMs: 60_000, consecutiveFailures: 3 }),
  ).toMatchObject({ kind: "defer", failures: 4 });
  expect(
    rateDecision({ retryAfterMs: 60_000, consecutiveFailures: 4 }),
  ).toEqual({
    kind: "pause",
    reason: "failure-cap",
    delayMs: 60_000,
    failures: RATE_FAILURE_CAP,
  });
  expect(
    rateDecision({ retryAfterMs: 60_000, consecutiveFailures: 5 }),
  ).toMatchObject({ kind: "pause", failures: RATE_FAILURE_CAP });
});

it("re-deferring an already-counted wait never reaches the failure cap", () => {
  expect(
    rateDecision({
      retryAfterMs: 5_000,
      consecutiveFailures: 4,
      countFailure: false,
    }),
  ).toEqual({ kind: "defer", delayMs: 5_000, failures: 4 });
});
