import type { Extraction } from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";

/** Document types that cannot carry cash payment or refund evidence. */
export const NON_CASH_DOCUMENT_TYPES = [
  "non-purchase",
  "cancellation",
  "statement",
  "unknown",
  "credit-note",
] as const;

export interface AiTextPart {
  readonly id: string;
  readonly text: string;
  readonly interpretation?: "model";
  readonly mimeType?: "text/plain" | "text/html";
}
export interface ApprovedAiConfig {
  readonly destinationId: string;
  readonly modelId: string;
  readonly mode: "hosted" | "byok";
  readonly settingsRevision: number;
  readonly consentId: string;
  readonly fingerprint: string;
  readonly promptVersion: string;
  readonly schemaVersion: 1;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxAttempts: 1 | 2;
  /** Upper bound includes input, output and any provider reasoning units. */
  readonly reservationUnits: number;
}
export interface AiUsage {
  readonly input: number;
  readonly output: number;
  readonly other: number;
  readonly source: "reported" | "estimated";
}
export type AiResponse =
  | {
      readonly status: "ok";
      readonly output: string;
      readonly finish: "complete" | "truncated";
      readonly usage: AiUsage | null;
    }
  | {
      readonly status: "failed";
      readonly reason:
        | "timeout"
        | "rate-limit"
        | "invalid-key"
        | "unsupported"
        | "refusal"
        | "outage";
      readonly usage: AiUsage | null;
      readonly retryAfterMs?: number;
    };
export interface InvoiceExtractor {
  extract(
    parts: readonly AiTextPart[],
    config: ApprovedAiConfig,
    attempt: { readonly id: string; readonly repair: boolean },
    signal?: AbortSignal,
  ): Promise<AiResponse>;
}
/** Review reasons (K8). The type union is derived from this one runtime array. */
export const AI_REASONS = [
  "schema",
  "evidence",
  "money",
  "date",
  "semantics",
  "incomplete",
  "input-limit",
  "settings-changed",
  "budget",
  "in-progress",
  "timeout",
  "rate-limit",
  "invalid-key",
  "unsupported",
  "refusal",
  "outage",
] as const;
export type AiReason = (typeof AI_REASONS)[number];
export type PersistedAiRecord = Omit<
  Extraction["records"][number],
  "evidence"
> & {
  readonly provenance: readonly {
    readonly field: Extraction["records"][number]["evidence"][number]["field"];
    readonly inputPartId: string;
  }[];
};
/** Incomplete-extraction fields (K8). Type union derived from the runtime array. */
export const AI_MISSING_FIELDS = [
  "merchant",
  "currency",
  "total",
  "documentDate",
] as const;
export type AiMissingField = (typeof AI_MISSING_FIELDS)[number];
export type PersistableAiResult =
  | {
      readonly status: "accepted";
      readonly documentType: Extraction["documentType"];
      readonly records: readonly PersistedAiRecord[];
      readonly warnings: Extraction["warnings"];
    }
  | {
      readonly status: "needs-review";
      readonly reason: "incomplete";
      readonly missingFields?: readonly AiMissingField[];
    }
  | {
      readonly status: "needs-review";
      readonly reason: Exclude<AiReason, "incomplete">;
      readonly missingFields?: never;
    };
export interface AiRunIdentity {
  readonly documentId: string;
  readonly contentHash: string;
  readonly extractionVersion: string;
}
export interface AiCheckpoint {
  readonly tenant: TenantContext;
  readonly identity: AiRunIdentity;
  readonly config: ApprovedAiConfig;
}
export interface AiAttemptIdentity extends AiCheckpoint {
  readonly attemptId: string;
  readonly attemptNumber: number;
}
export interface AiUsageStore {
  /** Atomic ownership/current-consent check plus tenant-scoped cached result. */
  checkpoint(
    input: AiCheckpoint,
  ): Promise<
    | { readonly status: "ready" }
    | { readonly status: "stale" }
    | { readonly status: "completed"; readonly result: PersistableAiResult }
  >;
  /** Atomic user AND global quota reservation. Existing pending/uncertain attempts never grant a new call. */
  reserve(
    input: AiAttemptIdentity,
  ): Promise<"reserved" | "budget" | "existing">;
  /** Re-check settings/consent after reservation and immediately before network. */
  authorize(input: AiAttemptIdentity): Promise<boolean>;
  /** Unknown or possibly billed usage MUST retain the upper reservation. */
  settle(
    input: AiAttemptIdentity,
    settlement: {
      readonly state: "known" | "uncertain" | "not-sent";
      readonly usage: AiUsage | null;
      readonly retryAfterMs?: number;
    },
  ): Promise<void>;
  complete(input: AiCheckpoint, result: PersistableAiResult): Promise<boolean>;
}
