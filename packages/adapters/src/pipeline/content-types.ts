import type { GmailDocumentInputResult } from "../documents/gmail";

export class ContentError extends Error {
  constructor(
    readonly code:
      | "CONTENT_AUTH_CHANGED"
      | "CONTENT_UNAVAILABLE"
      | "CONTENT_AUTH_REQUIRED"
      | "CONTENT_SOURCE_UNAVAILABLE"
      | "CONTENT_BYTE_LIMIT",
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
export interface ContentLoadInput {
  connectionId: string;
  providerMessageId: string;
  /** Server-owned persisted part identity for one inference stage. */
  partKey?: string;
  signal: AbortSignal;
  checkpoint: () => Promise<boolean>;
}
export interface TransientContentReader {
  load(input: ContentLoadInput): Promise<GmailDocumentInputResult>;
}
