import type { ArchiveQueuePort } from "@invoxim/core";
import { createArchiveDispatchStore } from "./dispatch-store";
import { createArchiveObjectStore } from "./objects";
import { createArchiveQueue } from "./queue";
import {
  createDriveArchiveWorkflow,
  type DriveArchiveWorkflowOptions,
} from "./workflow";
export type DriveArchiveJobOptions = Omit<
  DriveArchiveWorkflowOptions,
  "onClaim"
> & {
  queue: ArchiveQueuePort;
  dispatchLimit?: number;
};
/** One invocation handle owns dispatch lookup, workflow and fenced settlement. */
export function createDriveArchiveJob(options: DriveArchiveJobOptions) {
  return createArchiveQueue({
    store: createArchiveDispatchStore(options.db),
    objects: createArchiveObjectStore(options.db),
    queue: options.queue,
    remainingStatements: options.remainingStatements,
    ...(options.dispatchLimit === undefined
      ? {}
      : { dispatchLimit: options.dispatchLimit }),
    workflow: {
      run(context, objectId, signal, onClaim) {
        return createDriveArchiveWorkflow({ ...options, onClaim }).run(
          context,
          objectId,
          signal,
        );
      },
    },
  });
}
