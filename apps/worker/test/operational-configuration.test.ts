import { expect, it, vi } from "vitest";
import { configuredOperationalObserver } from "../src/operational-configuration";

const event = {
  kind: "schedule",
  outcome: "completed",
  scheduledCount: 0,
  sentCount: 0,
  consumedQueryCount: 2,
  wallDurationMs: 10,
} as const;
it("T24 explicitly configured service receives only validated operational aggregates", async () => {
  const captured: Request[] = [];
  const sink = {
    fetch: vi.fn(async (request: Request) => {
      captured.push(request);
      return new Response(null, { status: 204 });
    }),
  } as unknown as Fetcher;
  const observer = configuredOperationalObserver({
    OPERATIONAL_METRICS_ENABLED: "true",
    OPERATIONAL_METRICS_SECRET: "synthetic-operator-secret",
    OPERATIONAL_METRICS: sink,
  });
  await observer.observe(event);
  expect(captured).toHaveLength(1);
  const request = captured[0];
  expect(request?.url).toBe("https://operational-metrics.invalid/v1/events");
  expect(request?.headers.get("Authorization")).toBe(
    "Bearer synthetic-operator-secret",
  );
  expect(await request?.json()).toEqual(event);
});
it("T24 missing, invalid and default-disabled operator configuration never sends", async () => {
  const fetcher = vi.fn();
  const sink = { fetch: fetcher } as unknown as Fetcher;
  for (const config of [
    {},
    { OPERATIONAL_METRICS_ENABLED: "false" },
    { OPERATIONAL_METRICS_ENABLED: "true" },
    {
      OPERATIONAL_METRICS_ENABLED: "true",
      OPERATIONAL_METRICS_SECRET: "short",
    },
    {
      OPERATIONAL_METRICS_ENABLED: "true",
      OPERATIONAL_METRICS_SECRET: "synthetic-operator-secret",
      OPERATIONAL_METRICS_DEADLINE_MS: "251",
    },
  ]) {
    await configuredOperationalObserver({
      ...config,
      OPERATIONAL_METRICS: sink,
    }).observe(event);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
