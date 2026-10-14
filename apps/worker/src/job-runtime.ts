import { queueMessageSchema } from "@invoxim/contracts";
import type {
  JobAdmission,
  JobHandler,
  JobQueue,
  JobStore,
} from "@invoxim/core";
import { createJobEngine } from "@invoxim/core";
export function createJobRuntime(options: {
  store: JobStore;
  queue: JobQueue;
  handler?: JobHandler;
  admission?: JobAdmission;
  clock?: () => number;
}) {
  const engine = createJobEngine({
    ...options,
    onSettled: async () => options.queue.wakeDispatch?.(),
  });
  return {
    scheduled: () => engine.dispatch(),
    async queue(batch: MessageBatch<unknown>) {
      let acknowledgedCount = 0;
      let retriedCount = 0;
      // All repositories share the invocation's D1 cap. A continuation receives
      // its own platform invocation rather than a reset counter in this one.
      const message = batch.messages[0];
      if (message) {
        try {
          const parsed = queueMessageSchema.safeParse(message.body);
          let outcome: "ack" | "retry";
          if (parsed.success && "dispatch" in parsed.data) {
            await engine.dispatchReady();
            outcome = "ack";
          } else {
            outcome = await engine.consume(
              parsed.success ? parsed.data : message.body,
            );
          }
          if (outcome === "ack") {
            message.ack();
            acknowledgedCount++;
          } else {
            message.retry({ delaySeconds: 30 });
            retriedCount++;
          }
        } catch {
          message.retry({ delaySeconds: 30 });
          retriedCount++;
        }
      }
      for (const deferred of batch.messages.slice(1)) {
        // Legacy oversized batches have not acquired these jobs. Deliver them
        // promptly into fresh invocations, each with its own actual D1 cap.
        deferred.retry({ delaySeconds: 0 });
        retriedCount++;
      }
      return { acknowledgedCount, retriedCount };
    },
  };
}
