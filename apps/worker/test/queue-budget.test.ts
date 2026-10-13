import type { JobStore } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import { createJobRuntime } from "../src/job-runtime";

it("a queue invocation consumes at most one job so repositories share one bounded D1 budget", async () => {
  const claim = vi.fn(async () => null);
  const isSettled = vi.fn(async () => true);
  const store = { claim, isSettled } as unknown as JobStore;
  const messages = ["one", "two"].map((jobId) => ({
    id: jobId,
    timestamp: new Date(0),
    body: { schemaVersion: 1, jobId },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  await createJobRuntime({
    store,
    queue: { send: async () => undefined },
  }).queue({
    queue: "synthetic",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  });
  expect(claim.mock.calls).toEqual([["one"]]);
  expect(messages[0]?.ack).toHaveBeenCalledOnce();
  expect(messages[1]?.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
});
