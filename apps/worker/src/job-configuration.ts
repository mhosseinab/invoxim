import type { JobPolicy } from "@invoxim/core";
import { z } from "zod";

export interface JobBindings {
  DB?: D1Database;
  JOBS?: Queue<{ schemaVersion: 1; jobId: string }>;
  JOBS_ENABLED?: string;
  JOBS_QUERY_LIMIT?: string;
  JOBS_DISPATCH_LIMIT?: string;
  JOBS_SCHEDULE_LIMIT?: string;
  JOBS_TENANT_CONCURRENCY?: string;
  JOBS_GLOBAL_CONCURRENCY?: string;
  JOBS_MAX_ATTEMPTS?: string;
  JOBS_LEASE_MS?: string;
  JOBS_REDELIVERY_MS?: string;
}

const policySchema = z.strictObject({
  queryLimit: z.number().int().min(24).max(40),
  dispatchLimit: z.number().int().min(1).max(50),
  scheduleLimit: z.number().int().min(1).max(50),
  tenantConcurrency: z.number().int().min(1).max(2),
  globalConcurrency: z.number().int().min(1).max(100),
  maxAttempts: z.number().int().min(1).max(5),
  leaseMs: z.number().int().min(1000).max(300000),
  redeliveryMs: z.number().int().min(1000).max(3600000),
});

function integer(value: string | undefined, fallback: number): number {
  return value === undefined
    ? fallback
    : /^\d{1,8}$/.test(value)
      ? Number(value)
      : NaN;
}

export function jobConfiguration(bindings: JobBindings): JobPolicy | null {
  if (bindings.JOBS_ENABLED !== "true" || !bindings.DB || !bindings.JOBS)
    return null;
  const parsed = policySchema.safeParse({
    queryLimit: integer(bindings.JOBS_QUERY_LIMIT, 40),
    dispatchLimit: integer(bindings.JOBS_DISPATCH_LIMIT, 50),
    scheduleLimit: integer(bindings.JOBS_SCHEDULE_LIMIT, 25),
    tenantConcurrency: integer(bindings.JOBS_TENANT_CONCURRENCY, 2),
    globalConcurrency: integer(bindings.JOBS_GLOBAL_CONCURRENCY, 20),
    maxAttempts: integer(bindings.JOBS_MAX_ATTEMPTS, 3),
    leaseMs: integer(bindings.JOBS_LEASE_MS, 300000),
    redeliveryMs: integer(bindings.JOBS_REDELIVERY_MS, 60000),
  });
  return parsed.success ? parsed.data : null;
}
