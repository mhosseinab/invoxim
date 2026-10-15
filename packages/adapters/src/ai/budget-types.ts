import type {
  AiUsage,
  ApprovedAiConfig,
  JobLease,
  TenantContext,
} from "@invoxim/core";
import type { AiPricing } from "./pricing";

export interface AiBudgetPolicy {
  readonly dailyDocuments: number;
  readonly monthlyDocuments: number;
  readonly dailyUnits: number;
  readonly monthlyUnits: number;
  readonly globalDailyUsdMicros: string;
  readonly globalMonthlyUsdMicros: string;
}
/** Identity fields wrapped around the one shared pricing shape (A5). */
export type AiPriceSnapshot = AiPricing & {
  readonly destinationId: string;
  readonly modelId: string;
  readonly configVersion: string;
  readonly policyVersion: number;
  readonly configurationDigest: string;
  readonly acceptedConfigurationDigest?: string;
};
export interface AiBudgetOptions {
  readonly lease: JobLease;
  readonly policy: AiBudgetPolicy;
  readonly pricing: ReadonlyMap<string, AiPriceSnapshot>;
  readonly clock?: () => number;
}
export type AiProbeResult =
  | { readonly status: "passed" }
  | {
      readonly status: "failed";
      readonly reason:
        | "timeout"
        | "rate-limit"
        | "invalid-key"
        | "unsupported"
        | "refusal"
        | "outage"
        | "schema"
        | "incomplete";
    };
export interface AiProbeUsageStore {
  checkpoint(input: {
    readonly config: ApprovedAiConfig;
  }): Promise<
    | { status: "ready" }
    | { status: "stale" }
    | { status: "completed"; result: AiProbeResult }
  >;
  reserve(input: {
    readonly config: ApprovedAiConfig;
  }): Promise<"reserved" | "budget" | "existing">;
  authorize(input: { readonly config: ApprovedAiConfig }): Promise<boolean>;
  settle(
    input: { readonly config: ApprovedAiConfig },
    settlement: {
      readonly state: "known" | "uncertain" | "not-sent";
      readonly usage: AiUsage | null;
      readonly retryAfterMs?: number;
    },
  ): Promise<void>;
  complete(
    input: { readonly config: ApprovedAiConfig },
    result: AiProbeResult,
  ): Promise<boolean>;
}
export interface AiProbeBudgetOptions {
  readonly session: {
    readonly tenant: TenantContext;
    readonly sessionId: string;
  };
  readonly policy: AiBudgetPolicy;
  readonly pricing: ReadonlyMap<string, AiPriceSnapshot>;
  readonly clock?: () => number;
}
export interface ClassificationBudgetOptions extends AiBudgetOptions {
  readonly authorization: {
    readonly config: ApprovedAiConfig;
    readonly price: AiPriceSnapshot;
  };
  /** The configured classification provider and model (from configuration). */
  readonly destination: {
    readonly destinationId: string;
    readonly modelId: string;
  };
}
export type Settlement = {
  state: "known" | "uncertain" | "not-sent";
  usage: AiUsage | null;
  retryAfterMs?: number;
};
export type Binding = { generation: number; credential_version: number };
export type RunInput = {
  tenant: TenantContext;
  config: ApprovedAiConfig;
  documentId: string | null;
  contentHash: string;
  extractionVersion: string;
  runKey: string;
  attemptNumber: number;
};
export type Sql = { text: string; values: unknown[] };
export type BudgetOwner =
  | { kind: "extraction"; lease: JobLease }
  | {
      kind: "synthetic-test";
      session: { tenant: TenantContext; sessionId: string };
    };
export type MeterOptions = {
  policy: AiBudgetPolicy;
  pricing: ReadonlyMap<string, AiPriceSnapshot>;
  clock?: () => number;
  classificationAuthorization?: {
    config: ApprovedAiConfig;
    price: AiPriceSnapshot;
    destination: { destinationId: string; modelId: string };
  };
};
