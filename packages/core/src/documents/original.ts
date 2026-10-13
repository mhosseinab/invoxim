import { DOCUMENT_LIMITS } from "./types";

/** Whole MIME can exceed the selected receipt's limit; no partial original is returned. */
export const MAX_TRANSIENT_ORIGINAL_BYTES = DOCUMENT_LIMITS.bytes;
export type TransientOriginalResult =
  | {
      status: "ready";
      bytes: Uint8Array;
      mimeType: "message/rfc822";
      extension: ".eml";
      providerMessageId: string;
    }
  | { status: "source_unavailable" }
  | {
      status: "unsupported";
      code:
        | "byte_limit"
        | "invalid_encoding"
        | "unsupported_type"
        | "source_mismatch"
        | "invalid_original";
    };
/** An already authorized caller selects this source and rechecks ownership before each HTTP call. */
export interface TransientOriginalReader {
  read(input: {
    providerMessageId: string;
    signal: AbortSignal;
  }): Promise<TransientOriginalResult>;
}
export class OriginalReadError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "AUTH_REQUIRED"
      | "RATE_LIMITED"
      | "CANCELED"
      | "UNAVAILABLE",
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
