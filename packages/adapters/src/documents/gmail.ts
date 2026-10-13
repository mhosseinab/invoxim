import type {
  DocumentCode,
  DocumentInput,
  DocumentLimits,
  MimePart,
} from "@invoxim/core";
import { DOCUMENT_LIMITS } from "@invoxim/core";
import { z } from "zod";

const bodySchema = z.object({
  size: z.number().int().min(0),
  data: z.string().optional(),
  attachmentId: z.string().min(1).max(256).optional(),
});
const partSchema = z.object({
  partId: z.string().max(256),
  mimeType: z.string().min(1).max(128),
  filename: z.string().max(256).optional(),
  headers: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        value: z.string().max(8192),
      }),
    )
    .max(64)
    .optional(),
  body: bodySchema.optional(),
  parts: z.array(z.unknown()).max(64).optional(),
});
export interface GmailAttachmentContent {
  size: number;
  data: string;
}
export type GmailDocumentInputResult =
  | { status: "ready"; input: DocumentInput }
  | { status: "unreadable" | "incomplete"; code: DocumentCode };
/** Supplied content only. T09 discovery does not fetch it; this adapter has no fetch port. */
export function normalizeGmailDocumentInput(options: {
  connectionId: string;
  providerMessageId: string;
  payload: unknown;
  attachments?: ReadonlyMap<string, GmailAttachmentContent>;
  limits?: Partial<DocumentLimits>;
}): GmailDocumentInputResult {
  const limits = { ...DOCUMENT_LIMITS, ...options.limits };
  for (const key of Object.keys(DOCUMENT_LIMITS) as (keyof DocumentLimits)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > DOCUMENT_LIMITS[key]
    )
      throw new Error("INVALID_DOCUMENT_LIMITS");
  let count = 0;
  let bytes = 0;
  let headerCharacters = 0;
  const identities = new Set<string>();
  let failure: DocumentCode | null = null;
  function part(value: unknown, depth: number): MimePart | undefined {
    if (depth > limits.depth) {
      failure = "depth_limit";
      return;
    }
    if (++count > limits.parts) {
      failure = "part_limit";
      return;
    }
    if (!value || typeof value !== "object") {
      failure = "invalid_mime";
      return;
    }
    const raw = value as { parts?: unknown; headers?: unknown };
    if (raw.parts !== undefined) {
      if (!Array.isArray(raw.parts)) {
        failure = "invalid_mime";
        return;
      }
      if (raw.parts.length > limits.parts - count) {
        failure = "part_limit";
        return;
      }
    }
    if (
      raw.headers !== undefined &&
      (!Array.isArray(raw.headers) || raw.headers.length > 64)
    ) {
      failure = "invalid_mime";
      return;
    }
    const parsed = partSchema.safeParse(value);
    if (!parsed.success || identities.has(parsed.data.partId)) {
      failure = "invalid_mime";
      return;
    }
    const node = parsed.data;
    identities.add(node.partId);
    const headers = new Map<string, string>();
    for (const header of node.headers ?? []) {
      headerCharacters += header.name.length + header.value.length;
      if (headerCharacters > 8192) {
        failure = "byte_limit";
        return;
      }
      const name = header.name.toLowerCase();
      if (
        headers.has(name) &&
        ["content-type", "content-disposition", "content-id"].includes(name)
      ) {
        failure = "invalid_mime";
        return;
      }
      headers.set(name, header.value);
    }
    const result: MimePart = {
      partId: node.partId,
      mimeType: node.mimeType.toLowerCase(),
    };
    if (node.filename) result.filename = node.filename;
    const disposition = headers
      .get("content-disposition")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (disposition === "inline" || disposition === "attachment")
      result.disposition = disposition;
    const contentId = headers.get("content-id");
    if (contentId) result.contentId = contentId;
    const charset = /charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(
      headers.get("content-type") ?? "",
    );
    const encoding = charset?.[1] ?? charset?.[2];
    if (encoding) result.charset = encoding;
    if (result.mimeType.startsWith("multipart/")) {
      if (!node.parts?.length || node.body?.data || node.body?.attachmentId) {
        failure = "invalid_mime";
        return;
      }
      const children: MimePart[] = [];
      for (const child of node.parts) {
        const normalized = part(child, depth + 1);
        if (!normalized) return;
        children.push(normalized);
      }
      result.children = children;
      return result;
    }
    if (node.parts?.length || !node.body) {
      failure = "invalid_mime";
      return;
    }
    const suppliedContent = node.body.attachmentId
      ? options.attachments?.get(node.body.attachmentId)
      : node.body;
    const validatedContent = bodySchema.safeParse(suppliedContent);
    if (!validatedContent.success) {
      failure = "invalid_mime";
      return;
    }
    const content = validatedContent.data;
    if (
      !content ||
      content.size !== node.body.size ||
      content.data === undefined
    ) {
      failure = "invalid_mime";
      return;
    }
    bytes += content.size;
    if (
      bytes > limits.bytes ||
      content.data.length > Math.ceil(content.size / 3) * 4 + 2
    ) {
      failure = "byte_limit";
      return;
    }
    if (
      !/^[a-z0-9_-]*={0,2}$/i.test(content.data) ||
      content.data.replace(/=+$/, "").length % 4 === 1
    ) {
      failure = "invalid_encoding";
      return;
    }
    const unpadded = content.data.replace(/=+$/, "");
    const padding = content.data.length - unpadded.length;
    if (
      padding > 0 &&
      (content.data.length % 4 !== 0 ||
        padding !== (4 - (unpadded.length % 4)) % 4)
    ) {
      failure = "invalid_encoding";
      return;
    }
    try {
      const encoded = content.data
        .replace(/=+$/, "")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const binary = atob(encoded + "=".repeat((4 - (encoded.length % 4)) % 4));
      if (binary.length !== content.size) {
        failure = "invalid_encoding";
        return;
      }
      const canonical = btoa(binary)
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      if (canonical !== unpadded) {
        failure = "invalid_encoding";
        return;
      }
      result.bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
    } catch {
      failure = "invalid_encoding";
      return;
    }
    return result;
  }
  const root = part(options.payload, 1);
  if (!root) {
    const code = failure ?? "invalid_mime";
    return {
      status: code.endsWith("limit") ? "incomplete" : "unreadable",
      code,
    };
  }
  return {
    status: "ready",
    input: {
      connectionId: options.connectionId,
      providerMessageId: options.providerMessageId,
      root,
    },
  };
}
