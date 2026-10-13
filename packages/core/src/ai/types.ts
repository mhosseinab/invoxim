import type { Extraction } from "@invoxim/contracts";
import type { TenantContext } from "../tenant-context";

export interface AiTextPart {
  readonly id: string;
  readonly text: string;
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
export type AiReason =
  | "schema"
  | "evidence"
  | "money"
  | "date"
  | "semantics"
  | "incomplete"
  | "input-limit"
  | "settings-changed"
  | "budget"
  | "in-progress"
  | "timeout"
  | "rate-limit"
  | "invalid-key"
  | "unsupported"
  | "refusal"
  | "outage";
export type PersistedAiRecord = Omit<
  Extraction["records"][number],
  "evidence"
> & {
  readonly provenance: readonly {
    readonly field: Extraction["records"][number]["evidence"][number]["field"];
    readonly inputPartId: string;
  }[];
};
export type AiMissingField = "merchant" | "currency" | "total" | "documentDate";
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
