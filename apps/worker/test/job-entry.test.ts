import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const db = env.DB;

describe("T07 configured Worker entry points", () => {
  it("exposes scheduled and queue handlers alongside the established API", () => {
    expect(worker).toHaveProperty("scheduled", expect.any(Function));
    expect(worker).toHaveProperty("queue", expect.any(Function));
    expect(worker).toHaveProperty("fetch", expect.any(Function));
  });
  it("disabled, missing or invalid configuration leaves durable work untouched", async () => {
    const send = vi.fn();
    const queue = { send } as unknown as Queue<{
      schemaVersion: 1;
      jobId: string;
    }>;
    for (const bindings of [
      {},
      { DB: env.DB, JOBS_ENABLED: "true" },
      { DB: env.DB, JOBS: queue, JOBS_ENABLED: "false" },
      {
        DB: env.DB,
        JOBS: queue,
        JOBS_ENABLED: "true",
        JOBS_DISPATCH_LIMIT: "1000000",
      },
    ]) {
      const ackAll = vi.fn();
      const retryAll = vi.fn();
      const batch = {
        queue: "synthetic-jobs",
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        messages: [],
        ackAll,
        retryAll,
      };
      await worker.scheduled({} as ScheduledController, bindings);
      await worker.queue(batch, bindings);
      expect(ackAll).toHaveBeenCalledOnce();
      expect(retryAll).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
    // No migrations exist in this test's D1: accidentally touching job tables
    // makes scheduled throw or queue retry, rather than silently passing.
    expect(
      await db
        .prepare("SELECT name FROM sqlite_master WHERE name='jobs'")
        .first(),
    ).toBeNull();
  });
});
