import type { TenantContext } from "../tenant-context";

export interface DocumentLimits {
  bytes: number;
  parts: number;
  depth: number;
  pages: number;
  textCharacters: number;
}
export const DOCUMENT_LIMITS: Readonly<DocumentLimits> = {
  bytes: 4 * 1024 * 1024,
  parts: 64,
  depth: 8,
  pages: 20,
  textCharacters: 24000,
};
export interface MimePart {
  /** Exact provider identifier, including the empty root identifier. */
  partId: string;
  mimeType: string;
  disposition?: "inline" | "attachment";
  filename?: string;
  contentId?: string;
  charset?: string;
  bytes?: Uint8Array;
  children?: MimePart[];
}
export interface DocumentInput {
  connectionId: string;
  providerMessageId: string;
  root: MimePart;
}
export interface DocumentIdentity {
  connectionId: string;
  providerMessageId: string;
  partId: string;
}
export interface DocumentContext {
  tenant: TenantContext;
  signal?: AbortSignal;
  /** Preserve the selected part/hash for already staged version-one documents. */
  bodyAlternative?: "legacy-plain";
}
export type DocumentCode =
  | "byte_limit"
  | "part_limit"
  | "depth_limit"
  | "page_limit"
  | "text_limit"
  | "invalid_mime"
  | "invalid_encoding"
  | "unsupported_type"
  | "compressed_pdf"
  | "encrypted_pdf"
  | "active_pdf"
  | "malformed_pdf"
  | "textless_pdf"
  | "converter_unavailable"
  | "image_requires_verified_parser"
  | "canceled";
export type DocumentResult = {
  identity: DocumentIdentity;
  role: "body" | "attachment";
  mimeType: string;
  contentHash: string;
  parserVersion: string;
} & (
  | {
      status: "ready";
      textParts: { page: number | null; text: string }[];
      pageCount: number | null;
    }
  | {
      status: "needs_review" | "unsupported" | "unreadable" | "incomplete";
      code: DocumentCode;
    }
);
export interface MessageDocumentResult {
  status:
    | "ready"
    | "needs_review"
    | "unsupported"
    | "unreadable"
    | "incomplete";
  documents: DocumentResult[];
  ignoredPartIds: string[];
  code?: DocumentCode;
}
export interface DocumentTextExtractor {
  extract(
    input: DocumentInput,
    context: DocumentContext,
  ): Promise<MessageDocumentResult>;
}
export type PdfTextResult =
  | { status: "ready"; pages: string[]; parserVersion: string }
  | {
      status: "needs_review" | "unreadable" | "incomplete";
      code: DocumentCode;
      parserVersion: string;
    };
export interface PdfTextExtractor {
  extract(
    bytes: Uint8Array,
    limits: Readonly<DocumentLimits>,
    signal?: AbortSignal,
  ): Promise<PdfTextResult>;
}
