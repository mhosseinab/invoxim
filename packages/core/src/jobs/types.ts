import type { TenantContext } from "../tenant-context";
export interface JobPolicy {
  dispatchLimit: number;
  scheduleLimit: number;
  tenantConcurrency: number;
  globalConcurrency: number;
  maxAttempts: number;
  leaseMs: number;
  redeliveryMs: number;
  /** Fresh store per invocation; actual D1 statement execution cap. */
  queryLimit?: number;
}
export interface JobLease {
  context: TenantContext;
  jobId: string;
  connectionId: string;
  consentId: string;
  generation: number;
  syncStateId: string | null;
  type: string;
  leaseId: string;
  fence: number;
  expiresAt: number;
  attempt: number;
}
export interface NewJob {
  id: string;
  connectionId: string;
  consentId: string;
  generation: number;
  dedupeKey: string;
  type: string;
  syncStateId?: string;
  priority?: 0 | 1 | 2;
}
export interface DispatchCandidate {
  dispatchAt: number;
  dispatchedAt: number | null;
  context: TenantContext;
  jobId: string;
  fence: number;
}
export type JobOutcome =
  | { kind: "completed" }
  | { kind: "retry"; code: "transient" | "timeout"; retryAfterMs?: number }
  | { kind: "terminal"; code: "malformed" | "unsupported" }
  | { kind: "paused"; code: "budget" | "auth" | "handler-unavailable" };
export interface JobStore {
  enqueue(context: TenantContext, input: NewJob): Promise<boolean>;
  manualSync(
    context: TenantContext,
    connectionId: string,
  ): Promise<
    | { kind: "queued"; jobId: string }
    | { kind: "review-required" }
    | { kind: "cooldown" }
  >;
  scheduleDue(): Promise<number>;
  candidates(): Promise<DispatchCandidate[]>;
  dispatched(candidate: DispatchCandidate): Promise<boolean>;
  claim(jobId: string): Promise<JobLease | null>;
  checkpoint(lease: JobLease): Promise<boolean>;
  finish(lease: JobLease, outcome: JobOutcome): Promise<boolean>;
  isSettled(jobId: string): Promise<boolean>;
  recover(): Promise<number>;
}
export interface JobQueue {
  send(body: { schemaVersion: 1; jobId: string }): Promise<void>;
  /** Internal dispatch hint only; durable jobs remain the authoritative outbox. */
  wakeDispatch?(): Promise<void>;
}
export interface JobHandler {
  run(
    lease: JobLease,
    control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
  ): Promise<JobOutcome>;
}
export interface JobAdmission {
  allow(lease: JobLease): Promise<boolean>;
}
