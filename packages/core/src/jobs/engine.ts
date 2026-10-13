import { hasControlCharacters } from "@invoxim/contracts";
import type { JobAdmission, JobHandler, JobQueue, JobStore } from "./types";
export function createJobEngine(options: {
  store: JobStore;
  queue: JobQueue;
  handler?: JobHandler;
  admission?: JobAdmission;
  clock?: () => number;
  onSettled?: () => Promise<void>;
}) {
  const { store, queue, handler, admission } = options;
  const clock = options.clock ?? Date.now;
  async function dispatchReady() {
    let sent = 0;
    for (const candidate of await store.candidates()) {
      try {
        if (!(await store.dispatched(candidate))) continue;
        await queue.send({ schemaVersion: 1, jobId: candidate.jobId });
        sent++;
      } catch {
        /* Reservation expires; the durable outbox survives send failure. */
      }
    }
    return { sent };
  }
  async function acknowledgeSettlement(): Promise<"ack"> {
    try {
      await options.onSettled?.();
    } catch {
      // A lost wakeup cannot undo a durable result; Cron repairs the outbox.
    }
    return "ack";
  }
  return {
    dispatchReady,
    async dispatch() {
      await store.recover();
      const scheduled = await store.scheduleDue();
      return { scheduled, ...(await dispatchReady()) };
    },
    async consume(body: unknown): Promise<"ack" | "retry"> {
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !("schemaVersion" in body) ||
        body.schemaVersion !== 1 ||
        !("jobId" in body) ||
        typeof body.jobId !== "string" ||
        body.jobId.length === 0 ||
        body.jobId.length > 256 ||
        hasControlCharacters(body.jobId)
      )
        return "ack";
      const lease = await store.claim(body.jobId);
      if (!lease) return (await store.isSettled(body.jobId)) ? "ack" : "retry";
      const controller = new AbortController();
      const checkpoint = async () => {
        const allowed = await store.checkpoint(lease);
        if (!allowed) controller.abort();
        return allowed;
      };
      const bounded = <T>(operation: Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const expired = () => reject(new Error("JOB_DEADLINE"));
          if (controller.signal.aborted) expired();
          else
            controller.signal.addEventListener("abort", expired, {
              once: true,
            });
          operation.then(
            (value) => {
              controller.signal.removeEventListener("abort", expired);
              resolve(value);
            },
            (error: unknown) => {
              controller.signal.removeEventListener("abort", expired);
              reject(error);
            },
          );
        });
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, lease.expiresAt - clock()),
      );
      try {
        if (!(await checkpoint())) return "retry";
        if (!handler) {
          const won = await store.finish(lease, {
            kind: "paused",
            code: "handler-unavailable",
          });
          return won || (await store.isSettled(lease.jobId))
            ? acknowledgeSettlement()
            : "retry";
        }
        if (admission && !(await bounded(admission.allow(lease)))) {
          const won = await store.finish(lease, {
            kind: "paused",
            code: "budget",
          });
          return won || (await store.isSettled(lease.jobId))
            ? acknowledgeSettlement()
            : "retry";
        }
        if (!(await checkpoint())) return "retry";
        const outcome = await bounded(
          handler.run(lease, {
            signal: controller.signal,
            checkpoint,
          }),
        );
        if (await store.isSettled(lease.jobId)) return acknowledgeSettlement();
        await store.finish(lease, outcome);
        return (await store.isSettled(lease.jobId))
          ? acknowledgeSettlement()
          : "retry";
      } catch {
        if (await store.isSettled(lease.jobId)) return acknowledgeSettlement();
        await store.finish(lease, {
          kind: "retry",
          code: controller.signal.aborted ? "timeout" : "transient",
        });
        return (await store.isSettled(lease.jobId))
          ? acknowledgeSettlement()
          : "retry";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
