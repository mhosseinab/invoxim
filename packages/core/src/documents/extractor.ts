import { selectBodyText } from "./body-selection";
import { inertHtmlText } from "./html";
import { binarySignature } from "./signatures";
import type {
  DocumentCode,
  DocumentContext,
  DocumentInput,
  DocumentLimits,
  DocumentResult,
  DocumentTextExtractor,
  MessageDocumentResult,
  MimePart,
  PdfTextExtractor,
  PdfTextResult,
} from "./types";
import { DOCUMENT_LIMITS } from "./types";

/** Normalise a MIME type to its essence (lowercase, no parameters). */
function normalizeMime(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

/** Body vs attachment role from the part's MIME, filename and disposition (K9). */
function partRole(
  part: Pick<MimePart, "mimeType" | "filename" | "disposition">,
): "body" | "attachment" {
  const mime = normalizeMime(part.mimeType);
  return (mime === "text/plain" || mime === "text/html") &&
    !part.filename &&
    part.disposition !== "attachment"
    ? "body"
    : "attachment";
}

async function hashHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One PDF conversion call with the shared unavailable/disabled fallback (K9).
 * Callers own limit accounting and parser-version wrapping.
 */
async function convertPdf(
  pdf: PdfTextExtractor | undefined,
  bytes: Uint8Array,
  budget: Readonly<DocumentLimits>,
  signal: AbortSignal | undefined,
): Promise<PdfTextResult> {
  try {
    return pdf
      ? await pdf.extract(bytes, budget, signal)
      : {
          status: "needs_review",
          code: "converter_unavailable",
          parserVersion: "disabled",
        };
  } catch {
    return {
      status: "needs_review",
      code: "converter_unavailable",
      parserVersion: "unavailable",
    };
  }
}

function textlessPdf(result: PdfTextResult): boolean {
  return (
    result.status === "ready" &&
    (!Array.isArray(result.pages) ||
      result.pages.length === 0 ||
      result.pages.some(
        (text) => typeof text !== "string" || text.trim().length === 0,
      ))
  );
}

type PdfDocumentBase = Pick<
  DocumentResult,
  "identity" | "role" | "mimeType" | "contentHash"
>;

/**
 * Map a converted PDF onto one document result (K9). Both the legacy extract
 * loop and directModelInput share this shape; callers own limit accounting and
 * parser-version wrapping.
 */
function pdfDocument(
  base: PdfDocumentBase,
  parserVersion: string,
  converted: PdfTextResult,
): DocumentResult {
  if (converted.status !== "ready")
    return { ...base, ...converted, parserVersion };
  if (textlessPdf(converted))
    return {
      ...base,
      status: "needs_review",
      code: "textless_pdf",
      parserVersion,
    };
  const pages = converted.pages;
  return {
    ...base,
    status: "ready",
    parserVersion,
    textParts: pages.map((text, index) => ({
      page: index + 1,
      text,
    })),
    pageCount: pages.length,
  };
}

function boundedText(
  value: unknown,
  maximum: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= maximum &&
    [...value].every((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point >= 32 && point !== 127;
    })
  );
}
function validate(
  input: DocumentInput,
  limits: Readonly<DocumentLimits>,
): DocumentCode | null {
  if (
    !input ||
    !boundedText(input.connectionId, 256) ||
    !boundedText(input.providerMessageId, 256) ||
    !input.root
  )
    return "invalid_mime";
  const pending = [{ node: input.root, depth: 1 }];
  const nodes = new Set<MimePart>();
  const identities = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { node, depth } = entry;
    if (depth > limits.depth) return "depth_limit";
    if (
      !node ||
      typeof node !== "object" ||
      nodes.has(node) ||
      !boundedText(node.partId, 256, true) ||
      !boundedText(node.mimeType, 128)
    )
      return "invalid_mime";
    nodes.add(node);
    if (nodes.size > limits.parts) return "part_limit";
    if (identities.has(node.partId)) return "invalid_mime";
    identities.add(node.partId);
    for (const value of [node.filename, node.contentId, node.charset])
      if (value !== undefined && !boundedText(value, 256, true))
        return "invalid_mime";
    if (
      node.disposition !== undefined &&
      node.disposition !== "inline" &&
      node.disposition !== "attachment"
    )
      return "invalid_mime";
    if (node.bytes !== undefined) {
      if (!(node.bytes instanceof Uint8Array)) return "invalid_mime";
      bytes += node.bytes.byteLength;
      if (
        node.mimeType.toLowerCase().startsWith("text/") &&
        binarySignature(node.bytes)
      )
        return "invalid_mime";
    }
    if (bytes > limits.bytes) return "byte_limit";
    if (node.children !== undefined) {
      if (!Array.isArray(node.children) || node.children.length > limits.parts)
        return "part_limit";
      for (const child of node.children)
        pending.push({ node: child, depth: depth + 1 });
    }
    const multipart = normalizeMime(node.mimeType).startsWith("multipart/");
    if (
      multipart
        ? node.bytes !== undefined || !node.children?.length
        : node.children !== undefined || node.bytes === undefined
    )
      return "invalid_mime";
  }
  return null;
}
function readableHtml(part: MimePart): boolean {
  if (normalizeMime(part.mimeType) !== "text/html" || !part.bytes?.length)
    return false;
  try {
    const text = new TextDecoder(part.charset ?? "utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(part.bytes);
    const normalized = inertHtmlText(text);
    return normalized.complete && normalized.text.trim().length > 0;
  } catch {
    return false;
  }
}
function select(
  root: MimePart,
  ignored: string[],
  legacyPlain: boolean,
): MimePart[] {
  function visit(node: MimePart): {
    body: MimePart[];
    attachments: MimePart[];
  } {
    const mime = normalizeMime(node.mimeType);
    if (node.children) {
      const results = node.children.map(visit);
      const attachments = results.flatMap((result) => result.attachments);
      const bodies = results.flatMap((result) => result.body);
      if (mime === "multipart/alternative") {
        const body =
          (!legacyPlain ? bodies.find(readableHtml) : undefined) ??
          bodies.find(
            (part) =>
              normalizeMime(part.mimeType).startsWith("text/plain") &&
              part.bytes?.length,
          ) ??
          bodies.find((part) => part.bytes?.length);
        for (const part of bodies) if (part !== body) ignored.push(part.partId);
        return { body: body ? [body] : [], attachments };
      }
      return { body: bodies, attachments };
    }
    if (
      mime.startsWith("image/") &&
      node.disposition !== "attachment" &&
      (node.disposition === "inline" || node.contentId)
    ) {
      ignored.push(node.partId);
      return { body: [], attachments: [] };
    }
    if (partRole(node) === "body") return { body: [node], attachments: [] };
    return { body: [], attachments: [node] };
  }
  const result = visit(root);
  return [...result.body, ...result.attachments];
}

/** Length-framed bytes preserve each exact original byte sequence (direct mode). */
function framedGroupBytes(group: readonly MimePart[]): Uint8Array {
  const framed = group.map((part) => ({
    part,
    header: new TextEncoder().encode(
      JSON.stringify([part.partId, part.mimeType, part.bytes?.length ?? 0]),
    ),
  }));
  const hashBytes = new Uint8Array(
    framed.reduce(
      (size, item) =>
        size + 4 + item.header.length + (item.part.bytes?.length ?? 0),
      0,
    ),
  );
  let offset = 0;
  const view = new DataView(hashBytes.buffer);
  for (const item of framed) {
    view.setUint32(offset, item.header.length);
    offset += 4;
    hashBytes.set(item.header, offset);
    offset += item.header.length;
    if (item.part.bytes) {
      hashBytes.set(item.part.bytes, offset);
      offset += item.part.bytes.length;
    }
  }
  return hashBytes;
}

async function directModelInput(
  input: DocumentInput,
  limits: Readonly<DocumentLimits>,
  context: DocumentContext,
  pdf?: PdfTextExtractor,
): Promise<MessageDocumentResult> {
  const bodies: MimePart[] = [];
  const attachments: MimePart[] = [];
  const ignoredPartIds: string[] = [];
  function visit(node: MimePart) {
    if (node.children) {
      for (const child of node.children) visit(child);
      return;
    }
    const mime = normalizeMime(node.mimeType);
    if (
      mime.startsWith("image/") &&
      node.disposition !== "attachment" &&
      (node.disposition === "inline" || node.contentId)
    ) {
      ignoredPartIds.push(node.partId);
      return;
    }
    if (partRole(node) === "body") bodies.push(node);
    else attachments.push(node);
  }
  visit(input.root);
  const groups = [
    ...(bodies.length ? [bodies] : []),
    ...attachments.map((part) => [part]),
  ];
  const documents: DocumentResult[] = [];
  let characters = 0;
  let pageCount = 0;
  let partialCode: DocumentCode | undefined;
  for (const group of groups) {
    if (context.signal?.aborted)
      return {
        status: "needs_review",
        code: "canceled",
        documents: [],
        ignoredPartIds: [],
      };
    const first = group[0];
    if (!first?.bytes)
      return {
        status: "unreadable",
        code: "invalid_mime",
        documents: [],
        ignoredPartIds: [],
      };
    const grouped = group.length > 1;
    const identityPart = grouped ? input.root : first;
    const hashBytes = grouped ? framedGroupBytes(group) : first.bytes;
    const contentHash = await hashHex(hashBytes);
    const mimeType = normalizeMime(identityPart.mimeType);
    const base = {
      identity: {
        connectionId: input.connectionId,
        providerMessageId: input.providerMessageId,
        partId: identityPart.partId,
      },
      role: partRole(first),
      mimeType,
      contentHash,
      parserVersion: "documents-direct-v1",
    };
    if (mimeType === "application/pdf") {
      const exhausted =
        pageCount >= limits.pages
          ? "page_limit"
          : characters >= limits.textCharacters
            ? "text_limit"
            : null;
      if (exhausted) {
        documents.push({ ...base, status: "incomplete", code: exhausted });
        partialCode ??= exhausted;
        continue;
      }
      const converted = await convertPdf(
        pdf,
        first.bytes,
        {
          ...limits,
          pages: limits.pages - pageCount,
          textCharacters: limits.textCharacters - characters,
        },
        context.signal,
      );
      const parserVersion = `documents-direct-pdf-v2/${converted.parserVersion}`;
      if (converted.status !== "ready" || textlessPdf(converted)) {
        documents.push(pdfDocument(base, parserVersion, converted));
        if (converted.status === "incomplete") partialCode ??= converted.code;
        continue;
      }
      const pages = converted.pages;
      pageCount += pages.length;
      characters += pages.reduce((sum, page) => sum + page.length, 0);
      const code =
        pageCount > limits.pages
          ? "page_limit"
          : characters > limits.textCharacters
            ? "text_limit"
            : null;
      if (code) {
        documents.push({ ...base, status: "incomplete", code });
        partialCode ??= code;
        continue;
      }
      documents.push(pdfDocument(base, parserVersion, converted));
      continue;
    }
    if (
      group.some(
        (part) =>
          !["text/plain", "text/html"].includes(normalizeMime(part.mimeType)),
      )
    ) {
      documents.push({
        ...base,
        status: "needs_review",
        code: "converter_unavailable",
      });
      continue;
    }
    const textParts: {
      page: null;
      text: string;
      partId: string;
      mimeType: "text/plain" | "text/html";
    }[] = [];
    let invalidEncoding = false;
    let truncated = false;
    let selected = false;
    const decoded: {
      part: MimePart;
      text: string;
      mimeType: "text/plain" | "text/html";
    }[] = [];
    for (const part of group) {
      try {
        const text = new TextDecoder(part.charset ?? "utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(part.bytes);
        const mimeType = normalizeMime(part.mimeType);
        if (mimeType !== "text/plain" && mimeType !== "text/html")
          throw new Error("INVALID_TEXT_MIME");
        decoded.push({ part, text, mimeType });
      } catch {
        invalidEncoding = true;
        break;
      }
    }
    const isBody = base.role === "body";
    const rawCharacters = decoded.reduce(
      (sum, item) => sum + item.text.length,
      0,
    );
    let remaining = isBody
      ? limits.textCharacters
      : limits.textCharacters - characters;
    selected = isBody && rawCharacters > remaining;
    for (const [index, item] of decoded.entries()) {
      if (invalidEncoding) break;
      if (selected) {
        const maximum = Math.floor(remaining / (decoded.length - index));
        const selection = selectBodyText(
          item.text,
          item.mimeType === "text/html",
          maximum,
        );
        if (!selection.complete) {
          invalidEncoding = true;
          break;
        }
        truncated ||= selection.truncated;
        for (const span of selection.spans) {
          if (textParts.length >= 64) {
            truncated = true;
            break;
          }
          textParts.push({
            page: null,
            text: span.text,
            partId: `${item.part.partId}@${span.start}:${span.end}`,
            mimeType: item.mimeType,
          });
          remaining -= span.text.length;
        }
      } else {
        if (item.text.length > remaining) {
          truncated = true;
          break;
        }
        textParts.push({
          page: null,
          text: item.text,
          partId: item.part.partId,
          mimeType: item.mimeType,
        });
        remaining -= item.text.length;
      }
    }
    if (!isBody) characters = limits.textCharacters - remaining;
    if (truncated) partialCode ??= "text_limit";
    documents.push(
      invalidEncoding
        ? { ...base, status: "unreadable", code: "invalid_encoding" }
        : truncated && !isBody
          ? { ...base, status: "incomplete", code: "text_limit" }
          : {
              ...base,
              parserVersion: selected
                ? "documents-direct-selected-v2"
                : base.parserVersion,
              status: "ready",
              textParts,
              pageCount: null,
              ...(truncated ? { truncated: true as const } : {}),
            },
    );
  }
  return {
    ...(partialCode ? { code: partialCode } : {}),
    status:
      !partialCode && documents.every((document) => document.status === "ready")
        ? "ready"
        : "needs_review",
    documents,
    ignoredPartIds,
  };
}
export function createDocumentTextExtractor(
  options: {
    pdf?: PdfTextExtractor;
    limits?: Partial<DocumentLimits>;
  } = {},
): DocumentTextExtractor {
  const limits = { ...DOCUMENT_LIMITS, ...options.limits };
  for (const key of Object.keys(DOCUMENT_LIMITS) as (keyof DocumentLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > DOCUMENT_LIMITS[key]
    )
      throw new Error("INVALID_DOCUMENT_LIMITS");
  }
  return {
    async extract(input, context) {
      const failure = (
        status: MessageDocumentResult["status"],
        code: DocumentCode,
      ): MessageDocumentResult => ({
        status,
        code,
        documents: [],
        ignoredPartIds: [],
      });
      if (context.signal?.aborted) return failure("needs_review", "canceled");
      const invalid = validate(input, limits);
      if (invalid)
        return failure(
          invalid.endsWith("limit") ? "incomplete" : "unreadable",
          invalid,
        );
      if (context.inputMode === "direct-model")
        return directModelInput(input, limits, context, options.pdf);
      const ignoredPartIds: string[] = [];
      const documents: DocumentResult[] = [];
      let characters = 0;
      let pageCount = 0;
      for (const node of select(
        input.root,
        ignoredPartIds,
        context.bodyAlternative === "legacy-plain",
      )) {
        if (context.signal?.aborted) return failure("needs_review", "canceled");
        const bytes = node.bytes;
        if (!bytes) return failure("unreadable", "invalid_mime");
        const mimeType = normalizeMime(node.mimeType);
        const contentHash = await hashHex(bytes);
        const base = {
          identity: {
            connectionId: input.connectionId,
            providerMessageId: input.providerMessageId,
            partId: node.partId,
          },
          role: partRole(node),
          mimeType,
          contentHash,
          parserVersion:
            mimeType === "text/html" &&
            context.bodyAlternative !== "legacy-plain" &&
            partRole(node) === "body"
              ? "documents-v2"
              : "documents-v1",
        };
        if (mimeType === "text/plain" || mimeType === "text/html") {
          let text: string;
          try {
            text = new TextDecoder(node.charset ?? "utf-8", {
              fatal: true,
              ignoreBOM: false,
            }).decode(bytes);
          } catch {
            documents.push({
              ...base,
              status: "unreadable",
              code: "invalid_encoding",
            });
            continue;
          }
          if (mimeType === "text/html") {
            const normalized = inertHtmlText(text);
            if (!normalized.complete) {
              return failure("incomplete", "invalid_mime");
            }
            text = normalized.text;
          }
          characters += text.length;
          if (characters > limits.textCharacters)
            return failure("incomplete", "text_limit");
          documents.push({
            ...base,
            status: "ready",
            textParts: [{ page: null, text }],
            pageCount: null,
          });
        } else if (mimeType === "application/pdf") {
          if (pageCount >= limits.pages)
            return failure("incomplete", "page_limit");
          if (characters >= limits.textCharacters)
            return failure("incomplete", "text_limit");
          const result = await convertPdf(
            options.pdf,
            bytes,
            {
              ...limits,
              pages: limits.pages - pageCount,
              textCharacters: limits.textCharacters - characters,
            },
            context.signal,
          );
          if (result.status === "incomplete")
            return failure("incomplete", result.code);
          if (result.status === "ready" && !textlessPdf(result)) {
            const pages = result.pages;
            pageCount += pages.length;
            if (pageCount > limits.pages)
              return failure("incomplete", "page_limit");
            characters += pages.reduce((sum, text) => sum + text.length, 0);
            if (characters > limits.textCharacters)
              return failure("incomplete", "text_limit");
          }
          documents.push(pdfDocument(base, result.parserVersion, result));
        } else
          documents.push({
            ...base,
            status: mimeType.startsWith("image/")
              ? "needs_review"
              : "unsupported",
            code: mimeType.startsWith("image/")
              ? "image_requires_verified_parser"
              : "unsupported_type",
          });
      }
      const status = documents.every((document) => document.status === "ready")
        ? "ready"
        : "needs_review";
      return { status, documents, ignoredPartIds };
    },
  };
}
