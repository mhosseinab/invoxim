import { hasControlCharacters } from "@invoxim/contracts";
import { ArchiveServiceError } from "@invoxim/core";
import type {
  ArchiveObjectLease,
  ArchiveObjectStore,
} from "../../../core/src/archive/objects";
import type {
  ArchiveDispatchOutcome,
  ArchiveDispatchStore,
  ArchiveQueuePort,
  ArchiveQueueWorkflow,
} from "../../../core/src/archive/queue-types";
import type { ArchiveWorkflowResult } from "../../../core/src/archive/workflow-types";
import { DriveArchiveError } from "./types";

export interface ArchiveQueueOptions {
  store: ArchiveDispatchStore;
  workflow: ArchiveQueueWorkflow;
  queue: ArchiveQueuePort;
  objects: Pick<ArchiveObjectStore, "release">;
  remainingStatements(): number;
  clock?: () => number;
  dispatchLimit?: number;
}
function messageId(body: unknown): string | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !("schemaVersion" in body) ||
    body.schemaVersion !== 2 ||
    !("archiveId" in body) ||
    typeof body.archiveId !== "string" ||
    body.archiveId.length < 1 ||
    body.archiveId.length > 256 ||
    hasControlCharacters(body.archiveId)
  )
    return null;
  return body.archiveId;
}
function failure(error: unknown): ArchiveDispatchOutcome {
  if (error instanceof DriveArchiveError) {
    switch (error.code) {
      case "folder_missing":
        return { kind: "paused", code: "folder_missing" };
      case "missing_file":
        return { kind: "paused", code: "file_missing" };
      case "quota_exceeded":
        return { kind: "paused", code: "quota" };
      case "permission_denied":
      case "reconnect_required":
        return { kind: "paused", code: "auth_required" };
      case "metadata_mismatch":
      case "invalid_input":
        return { kind: "paused", code: "conflict" };
    }
  }
  if (error instanceof ArchiveServiceError) {
    if (error.code === "CONFLICT" || error.code === "ACCOUNT_MISMATCH")
      return { kind: "paused", code: "conflict" };
    if (error.code !== "UNAVAILABLE")
      return { kind: "paused", code: "auth_required" };
  }
  return { kind: "retry", code: "transient" };
}
function resultOutcome(result: ArchiveWorkflowResult): ArchiveDispatchOutcome {
  switch (result.status) {
    case "archived":
      return { kind: "completed" };
    case "unsupported":
      return { kind: "terminal", code: "unsupported" };
    case "source_unavailable":
      return { kind: "terminal", code: "source_missing" };
    case "not_claimed":
      return { kind: "deferred", code: "busy" };
    case "deferred":
      return { kind: "deferred", code: "deferred" };
  }
}
export function createArchiveQueue(options: ArchiveQueueOptions) {
  const { store, workflow, queue, objects, remainingStatements } = options;
  const clock = options.clock ?? Date.now;
  const dispatchLimit = options.dispatchLimit ?? 5;
  if (
    !Number.isSafeInteger(dispatchLimit) ||
    dispatchLimit < 1 ||
    dispatchLimit > 50
  )
    throw new ArchiveServiceError("INVALID_INPUT");
  async function settled(queueId: string): Promise<"ack" | "retry"> {
    if (remainingStatements() < 1) return "retry";
    const value = await store.load(queueId);
    return value.kind === "missing" ||
      value.kind === "blocked" ||
      value.kind === "completed"
      ? "ack"
      : "retry";
  }
  return {
    dispatch: async (): Promise<{ sent: number }> => {
      // A raw candidate may need retirement instead of reservation; both are bounded by this prefix.
      const limit = Math.min(
        dispatchLimit,
        Math.floor((remainingStatements() - 4) / 2),
      );
      if (limit < 1) return { sent: 0 };
      let sent = 0;
      for (const candidate of await store.due(limit)) {
        if (remainingStatements() < 4) break;
        try {
          const reserved = await store.reserve(candidate);
          if (!reserved) continue;
          await queue.send({ schemaVersion: 2, archiveId: reserved.queueId });
          sent++;
        } catch {
          // The durable reservation expires for redelivery, including ambiguous send success.
        }
      }
      return { sent };
    },
    consume: async (body: unknown): Promise<"ack" | "retry"> => {
      const queueId = messageId(body);
      if (queueId === null) return "ack";
      if (remainingStatements() < 4) return "retry";
      const lookup = await store.load(queueId);
      if (lookup.kind !== "ready")
        return lookup.kind === "busy" ? "retry" : "ack";
      const work = lookup.work;
      const controller = new AbortController();
      const captured: { lease: ArchiveObjectLease | null } = { lease: null };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onClaim = (value: ArchiveObjectLease) => {
        if (captured.lease !== null || value.id !== work.objectId)
          throw new ArchiveServiceError("CONFLICT");
        captured.lease = value;
        timer = setTimeout(
          () => controller.abort(),
          Math.max(1, value.expiresAt - clock()),
        );
      };
      function bounded(
        operation: Promise<ArchiveWorkflowResult>,
      ): Promise<ArchiveWorkflowResult> {
        return new Promise((resolve, reject) => {
          const aborted = () => reject(new ArchiveServiceError("UNAVAILABLE"));
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) aborted();
          operation.then(
            (value) => {
              controller.signal.removeEventListener("abort", aborted);
              resolve(value);
            },
            (error) => {
              controller.signal.removeEventListener("abort", aborted);
              reject(error);
            },
          );
        });
      }
      async function finish(
        outcome: ArchiveDispatchOutcome,
      ): Promise<"ack" | "retry"> {
        // No claim means no execution fence was acquired. Never guess or settle a newer lease.
        if (captured.lease === null) return settled(work.queueId);
        if (remainingStatements() < 2) return "retry";
        const won = await store.settle(
          { ...work, objectFence: captured.lease.fence },
          outcome,
        );
        return won ? "ack" : settled(work.queueId);
      }
      try {
        const result = await bounded(
          workflow.run(work.context, work.objectId, controller.signal, onClaim),
        );
        return await finish(resultOutcome(result));
      } catch (error) {
        controller.abort();
        if (captured.lease !== null && remainingStatements() >= 3)
          await objects.release(work.context, captured.lease);
        return await finish(failure(error));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
