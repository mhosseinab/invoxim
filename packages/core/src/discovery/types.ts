import type { TenantContext } from "../tenant-context";
export type DiscoveryQueryMode = "filtered" | "broad";
export interface DiscoveryRange {
  startMs: number;
  cutoffMs: number;
  timezone: string;
}
export interface DiscoveryPlan {
  range: DiscoveryRange;
  recent: DiscoveryRange;
  older: DiscoveryRange | null;
}
export interface DiscoveryMetadata {
  id: string;
  receivedAtMs: number;
  available: boolean;
  excluded: boolean;
  candidate: "matched" | "unknown";
}
export interface DiscoveryPage {
  ids: string[];
  deletedIds?: string[];
  nextPageToken?: string;
  historyId?: string;
}
export interface DiscoveryProviderPort {
  anchor(signal: AbortSignal): Promise<string>;
  list(input: {
    range: DiscoveryRange;
    queryMode: DiscoveryQueryMode;
    pageToken?: string;
    signal: AbortSignal;
  }): Promise<DiscoveryPage>;
  metadata(
    id: string,
    queryMode: DiscoveryQueryMode,
    signal: AbortSignal,
  ): Promise<DiscoveryMetadata>;
  history(input: {
    historyId: string;
    pageToken?: string;
    signal: AbortSignal;
  }): Promise<DiscoveryPage>;
}
export interface DiscoveryProviderFactory {
  open(
    context: TenantContext,
    input: { connectionId: string; generation: number },
    signal: AbortSignal,
  ): Promise<DiscoveryProviderPort>;
}
export interface DiscoveryProcessingSelection {
  readonly mode: "hosted" | "byok" | null;
  readonly settingsRevision: number;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly configVersion: string | null;
  readonly policyVersion: number;
  readonly acceptedDigest: string | null;
}
export interface DiscoveryReadinessPort {
  readonly requiresProcessingSelection?: boolean;
  allow(
    context: TenantContext,
    input: {
      connectionId: string;
      generation: number;
      consentId: string;
      disclosureVersion: number;
      settingsRevision: number;
      queryMode: DiscoveryQueryMode;
      processingSelection?: DiscoveryProcessingSelection;
    },
  ): Promise<boolean>;
}
export interface AcceptedImportInput {
  connectionId: string;
  generation: number;
  consentId: string;
  fingerprint: string;
  cutoffMs: number;
  startMs?: number;
  timezone: string;
  queryMode: DiscoveryQueryMode;
}
export class DiscoveryError extends Error {
  constructor(
    readonly code:
      | "UNAUTHORIZED"
      | "INVALID_RANGE"
      | "CONFLICT"
      | "UNAVAILABLE"
      | "SOURCE_UNAVAILABLE"
      | "HISTORY_EXPIRED"
      | "RATE_LIMITED"
      | "AUTH_REQUIRED",
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
