import type { TenantContext } from "../tenant-context";
import type { ArchiveObjectLease } from "./objects";
import type { ArchiveWorkflowResult } from "./workflow-types";

export interface ArchiveQueueMessage {
  schemaVersion: 2;
  archiveId: string;
}
export interface ArchiveDispatchWork {
  context: TenantContext;
  objectId: string;
  queueId: string;
  dispatchFence: number;
  objectFence: number;
  failureCount: number;
}
export interface ArchiveDispatchCandidate extends ArchiveDispatchWork {
  dispatchAt: number;
  dispatchedAt: number | null;
}
export type ArchiveDispatchLookup =
  | { kind: "ready"; work: ArchiveDispatchWork }
  | { kind: "missing" | "blocked" | "busy" | "completed" };
export type ArchiveDispatchOutcome =
  | { kind: "completed" }
  | { kind: "deferred"; code: "deferred" | "budget" | "busy" }
  | { kind: "retry"; code: "transient" }
  | {
      kind: "paused";
      code:
        | "auth_required"
        | "folder_missing"
        | "file_missing"
        | "quota"
        | "conflict";
    }
  | { kind: "terminal"; code: "unsupported" | "source_missing" };
export interface ArchiveDispatchStore {
  enqueue(
    context: TenantContext,
    objectId: string,
    queueId: string,
    runId?: string,
  ): Promise<boolean>;
  load(queueId: string): Promise<ArchiveDispatchLookup>;
  due(limit: number): Promise<ArchiveDispatchCandidate[]>;
  reserve(
    candidate: ArchiveDispatchCandidate,
  ): Promise<ArchiveDispatchWork | null>;
  /** Caller supplies the exact object execution fence; no active/newer lease can be overwritten. */
  settle(
    work: ArchiveDispatchWork,
    outcome: ArchiveDispatchOutcome,
  ): Promise<boolean>;
}
export interface ArchiveQueueWorkflow {
  run(
    context: TenantContext,
    objectId: string,
    signal: AbortSignal,
    onClaim: (lease: ArchiveObjectLease) => void,
  ): Promise<ArchiveWorkflowResult>;
}
export interface ArchiveQueuePort {
  send(message: ArchiveQueueMessage): Promise<void>;
}
