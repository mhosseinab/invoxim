import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";

function fixture() {
  const captured: unknown[] = [];
  const destination = {
    fetch: vi.fn(async (request: Request) => {
      captured.push(await request.json());
      return new Response(null, { status: 204 });
    }),
  } as unknown as Fetcher;
  return {
    captured,
    bindings: {
      OPERATIONAL_METRICS_ENABLED: "true",
      OPERATIONAL_METRICS_SECRET: "synthetic-operator-secret",
      OPERATIONAL_METRICS: destination,
    },
  };
}
it("T24 actual scheduled entry records unavailable dispatch without private identifiers", async () => {
  const f = fixture();
  await worker.scheduled({} as ScheduledController, f.bindings);
  expect(f.captured).toEqual([
    expect.objectContaining({
      kind: "schedule",
      outcome: "unavailable",
      scheduledCount: 0,
      sentCount: 0,
      consumedQueryCount: 0,
    }),
  ]);
});
it("T24 actual disabled queue preserves acknowledgement and observes only aggregate counts", async () => {
  const f = fixture();
  const ackAll = vi.fn();
  const batch = {
    queue: "synthetic-private-queue",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: [],
    ackAll,
    retryAll: vi.fn(),
  };
  await worker.queue(batch, f.bindings);
  expect(ackAll).toHaveBeenCalledOnce();
  expect(f.captured).toEqual([
    expect.objectContaining({
      kind: "queue",
      outcome: "disabled",
      acknowledgedCount: 0,
      retriedCount: 0,
      consumedQueryCount: 0,
    }),
  ]);
  expect(JSON.stringify(f.captured)).not.toContain(batch.queue);
});

it("T24 prior acknowledgements remain unknown when a later queue operation fails", async () => {
  const f = fixture();
  const acknowledged = vi.fn();
  const retryAll = vi.fn();
  const batch = {
    queue: "synthetic-private-queue",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: [
      {
        id: "synthetic-first",
        timestamp: new Date(),
        attempts: 1,
        body: { poison: true },
        ack: acknowledged,
        retry: vi.fn(),
      },
      {
        id: "synthetic-second",
        timestamp: new Date(),
        attempts: 1,
        body: { poison: true },
        ack: vi.fn(),
        retry: () => {
          throw new Error("synthetic-private-error");
        },
      },
    ],
    ackAll: vi.fn(),
    retryAll,
  };
  await worker.queue(batch, {
    ...f.bindings,
    DB: env.DB,
    JOBS_ENABLED: "true",
    JOBS: { send: vi.fn() } as unknown as Queue<{
      schemaVersion: 1;
      jobId: string;
    }>,
  });
  expect(acknowledged).toHaveBeenCalledOnce();
  expect(retryAll).toHaveBeenCalledOnce();
  expect(f.captured).toEqual([
    expect.objectContaining({
      kind: "queue",
      outcome: "failed",
      acknowledgedCount: null,
      retriedCount: null,
    }),
  ]);
  expect(JSON.stringify(f.captured)).not.toContain("synthetic-private");
});
