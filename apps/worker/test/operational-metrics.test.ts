import { expect, it } from "vitest";
import { createOperationalObserver } from "../src/operational-metrics";

const schedule = {
  kind: "schedule",
  outcome: "completed",
  scheduledCount: 2,
  sentCount: 1,
  consumedQueryCount: 17,
  wallDurationMs: 42,
} as const;

it("T24 records only closed operational aggregates supplied by the caller", async () => {
  const captured: unknown[] = [];
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      captured.push(event);
    },
  });
  const events = [
    schedule,
    {
      kind: "queue",
      outcome: "retry",
      acknowledgedCount: 0,
      retriedCount: 2,
      consumedQueryCount: 40,
      wallDurationMs: 100,
    },
    {
      kind: "cleanup",
      outcome: "awaiting_journal",
      unitCount: 1,
      consumedQueryCount: 3,
      wallDurationMs: 5000,
    },
  ];
  for (const event of events) await observer.observe(event);
  expect(captured).toEqual(events);
});

it("T24 refuses private fields and arbitrary outcomes before calling the sink", async () => {
  const captured: unknown[] = [];
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      captured.push(event);
    },
  });
  for (const forbidden of [
    { tenantId: "synthetic-private-tenant" },
    { jobId: "synthetic-private-job" },
    { documentId: "synthetic-private-document" },
    { merchant: "Synthetic private merchant" },
    { amount: "12345" },
    { url: "https://example.test/private" },
    { rawError: "synthetic-private-provider-error" },
    { label: "synthetic-private-label" },
    { outcome: "synthetic-private-provider-error" },
  ]) {
    await observer.observe({ ...schedule, ...forbidden });
  }
  expect(captured).toEqual([]);
});

it("T24 defaults off and explicitly disabled observers emit nothing", async () => {
  const captured: unknown[] = [];
  const sink = async (event: unknown) => {
    captured.push(event);
  };
  await createOperationalObserver({ sink }).observe(schedule);
  await createOperationalObserver({ enabled: false, sink }).observe(schedule);
  await createOperationalObserver({ enabled: true }).observe(schedule);
  expect(captured).toEqual([]);
});

it("T24 rejects invalid measurements rather than reporting CPU or invented counts", async () => {
  const captured: unknown[] = [];
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      captured.push(event);
    },
  });
  for (const invalid of [
    { consumedQueryCount: 41 },
    { consumedQueryCount: -1 },
    { consumedQueryCount: 1.5 },
    { wallDurationMs: NaN },
    { wallDurationMs: Infinity },
    { wallDurationMs: -1 },
    { scheduledCount: 51 },
    { sentCount: -1 },
    { cpuMs: 1 },
  ]) {
    await observer.observe({ ...schedule, ...invalid });
  }
  expect(captured).toEqual([]);
});

it("T24 caps emissions per invocation observer including concurrent observations", async () => {
  const captured: unknown[] = [];
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      captured.push(event);
    },
  });
  await Promise.all(
    Array.from({ length: 20 }, () => observer.observe(schedule)),
  );
  expect(captured).toEqual([schedule, schedule, schedule]);
  expect(captured.every((event) => JSON.stringify(event).length <= 512)).toBe(
    true,
  );
});

it("T24 sink rejection cannot alter an existing caller decision or expose its error", async () => {
  const observer = createOperationalObserver({
    enabled: true,
    sink: async () => {
      throw new Error("synthetic-private-error");
    },
  });
  const decision = { ack: true, retry: false, cleanup: "pending" };
  await expect(observer.observe(schedule)).resolves.toBeUndefined();
  expect(decision).toEqual({ ack: true, retry: false, cleanup: "pending" });
});

it("T24 a hung sink is aborted within the observation deadline", async () => {
  let observedSignal: AbortSignal | undefined;
  const observer = createOperationalObserver({
    enabled: true,
    deadlineMs: 10,
    sink: async (_event, signal) => {
      observedSignal = signal;
      await new Promise<void>(() => {});
    },
  });
  const started = Date.now();
  await observer.observe(schedule);
  expect(observedSignal?.aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
});

it("T24 malformed observations with throwing getters remain harmless", async () => {
  const captured: unknown[] = [];
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      captured.push(event);
    },
  });
  const hostile = {
    get kind() {
      throw new Error("synthetic-private-getter-error");
    },
  };
  await expect(observer.observe(hostile)).resolves.toBeUndefined();
  expect(captured).toEqual([]);
});

it("T24 invalid deadline configuration fails closed without sending events", async () => {
  const captured: unknown[] = [];
  for (const deadlineMs of [0, -1, 1.5, 251, Infinity, NaN]) {
    await createOperationalObserver({
      enabled: true,
      deadlineMs,
      sink: async (event) => {
        captured.push(event);
      },
    }).observe(schedule);
  }
  expect(captured).toEqual([]);
});

it("T24 failed sink attempts consume the emission cap", async () => {
  let attempts = 0;
  const observer = createOperationalObserver({
    enabled: true,
    sink: () => {
      attempts++;
      throw new Error("synthetic-private-synchronous-error");
    },
  });
  await Promise.all(
    Array.from({ length: 20 }, () => observer.observe(schedule)),
  );
  expect(attempts).toBe(3);
});

it("T24 copies and freezes the allowed payload before handing it to the sink", async () => {
  const input = { ...schedule };
  let captured: unknown;
  const observer = createOperationalObserver({
    enabled: true,
    sink: async (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(event).not.toBe(input);
      captured = event;
    },
  });
  await observer.observe(input);
  expect(captured).toEqual(schedule);
});
