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
  const engine = createJobEngine(options);
  return {
    scheduled: () => engine.dispatch(),
    async queue(batch: MessageBatch<unknown>): Promise<void> {
      // All repositories share the invocation's D1 cap. A continuation receives
      // its own platform invocation rather than a reset counter in this one.
      const message = batch.messages[0];
      if (message) {
        try {
          if ((await engine.consume(message.body)) === "ack") message.ack();
          else message.retry({ delaySeconds: 30 });
        } catch {
          message.retry({ delaySeconds: 30 });
        }
      }
      for (const deferred of batch.messages.slice(1))
        deferred.retry({ delaySeconds: 30 });
    },
  };
}
