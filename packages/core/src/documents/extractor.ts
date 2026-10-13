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
    const multipart = node.mimeType.toLowerCase().startsWith("multipart/");
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
  if (
    part.mimeType.toLowerCase().split(";")[0]?.trim() !== "text/html" ||
    !part.bytes?.length
  )
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
    const mime = node.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (node.children) {
      const results = node.children.map(visit);
      const attachments = results.flatMap((result) => result.attachments);
      const bodies = results.flatMap((result) => result.body);
      if (mime === "multipart/alternative") {
        const body =
          (!legacyPlain ? bodies.find(readableHtml) : undefined) ??
          bodies.find(
            (part) =>
              part.mimeType.toLowerCase().startsWith("text/plain") &&
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
    if (
      (mime === "text/plain" || mime === "text/html") &&
      node.disposition !== "attachment" &&
      !node.filename
    )
      return { body: [node], attachments: [] };
    return { body: [], attachments: [node] };
  }
  const result = visit(root);
  return [...result.body, ...result.attachments];
}
async function directModelInput(
  input: DocumentInput,
  limits: Readonly<DocumentLimits>,
  context: DocumentContext,
): Promise<MessageDocumentResult> {
  const bodies: MimePart[] = [];
  const attachments: MimePart[] = [];
  const ignoredPartIds: string[] = [];
  function visit(node: MimePart) {
    if (node.children) {
      for (const child of node.children) visit(child);
      return;
    }
    const mime = node.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (
      mime.startsWith("image/") &&
      node.disposition !== "attachment" &&
      (node.disposition === "inline" || node.contentId)
    ) {
      ignoredPartIds.push(node.partId);
      return;
    }
    if (
      (mime === "text/plain" || mime === "text/html") &&
      !node.filename &&
      node.disposition !== "attachment"
    )
      bodies.push(node);
    else attachments.push(node);
  }
  visit(input.root);
  const groups = [
    ...(bodies.length ? [bodies] : []),
    ...attachments.map((part) => [part]),
  ];
  const documents: DocumentResult[] = [];
  let characters = 0;
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
    let hashBytes: Uint8Array;
    if (!grouped) hashBytes = first.bytes;
    else {
      // Length framing preserves each exact original byte sequence and its provider part identity.
      const framed = group.map((part) => ({
        part,
        header: new TextEncoder().encode(
          JSON.stringify([part.partId, part.mimeType, part.bytes?.length ?? 0]),
        ),
      }));
      hashBytes = new Uint8Array(
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
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(hashBytes),
    );
    const mimeType =
      identityPart.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    const base = {
      identity: {
        connectionId: input.connectionId,
        providerMessageId: input.providerMessageId,
        partId: identityPart.partId,
      },
      role:
        !first.filename &&
        first.disposition !== "attachment" &&
        ["text/plain", "text/html"].includes(
          first.mimeType.toLowerCase().split(";")[0]?.trim() ?? "",
        )
          ? ("body" as const)
          : ("attachment" as const),
      mimeType,
      contentHash: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      parserVersion: "documents-direct-v1",
    };
    if (
      group.some(
        (part) =>
          !["text/plain", "text/html"].includes(
            part.mimeType.toLowerCase().split(";")[0]?.trim() ?? "",
          ),
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
    for (const part of group) {
      try {
        const text = new TextDecoder(part.charset ?? "utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(part.bytes);
        characters += text.length;
        if (characters > limits.textCharacters)
          return {
            status: "incomplete",
            code: "text_limit",
            documents: [],
            ignoredPartIds: [],
          };
        const textMime = part.mimeType.toLowerCase().split(";")[0]?.trim();
        if (textMime !== "text/plain" && textMime !== "text/html")
          throw new Error("INVALID_TEXT_MIME");
        textParts.push({
          page: null,
          text,
          partId: part.partId,
          mimeType: textMime,
        });
      } catch {
        invalidEncoding = true;
        break;
      }
    }
    documents.push(
      invalidEncoding
        ? { ...base, status: "unreadable", code: "invalid_encoding" }
        : { ...base, status: "ready", textParts, pageCount: null },
    );
  }
  return {
    status: documents.every((document) => document.status === "ready")
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
        return directModelInput(input, limits, context);
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
        const mimeType =
          node.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new Uint8Array(bytes),
        );
        const base = {
          identity: {
            connectionId: input.connectionId,
            providerMessageId: input.providerMessageId,
            partId: node.partId,
          },
          role: ((mimeType === "text/plain" || mimeType === "text/html") &&
          !node.filename &&
          node.disposition !== "attachment"
            ? "body"
            : "attachment") as "body" | "attachment",
          mimeType,
          contentHash: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          parserVersion:
            mimeType === "text/html" &&
            context.bodyAlternative !== "legacy-plain" &&
            !node.filename &&
            node.disposition !== "attachment"
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
          let result: PdfTextResult;
          try {
            result = options.pdf
              ? await options.pdf.extract(
                  bytes,
                  {
                    ...limits,
                    pages: limits.pages - pageCount,
                    textCharacters: limits.textCharacters - characters,
                  },
                  context.signal,
                )
              : {
                  status: "needs_review",
                  code: "converter_unavailable",
                  parserVersion: "disabled",
                };
          } catch {
            result = {
              status: "needs_review",
              code: "converter_unavailable",
              parserVersion: "unavailable",
            };
          }
          if (result.status === "incomplete")
            return failure("incomplete", result.code);
          if (result.status === "ready") {
            if (
              !Array.isArray(result.pages) ||
              result.pages.length === 0 ||
              result.pages.some(
                (text) => typeof text !== "string" || text.trim().length === 0,
              )
            ) {
              documents.push({
                ...base,
                status: "needs_review",
                code: "textless_pdf",
                parserVersion: result.parserVersion,
              });
              continue;
            }
            pageCount += result.pages.length;
            if (pageCount > limits.pages)
              return failure("incomplete", "page_limit");
            characters += result.pages.reduce(
              (sum, text) => sum + text.length,
              0,
            );
            if (characters > limits.textCharacters)
              return failure("incomplete", "text_limit");
            documents.push({
              ...base,
              parserVersion: result.parserVersion,
              status: "ready",
              textParts: result.pages.map((text, index) => ({
                page: index + 1,
                text,
              })),
              pageCount: result.pages.length,
            });
          } else documents.push({ ...base, ...result });
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
