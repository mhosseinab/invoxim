import type {
  DocumentCode,
  DocumentLimits,
  PdfTextExtractor,
  PdfTextResult,
} from "@invoxim/core";
import { getDocumentProxy } from "unpdf";

const parserVersion = "unpdf-1.8.1/uncompressed-v1";
const filterNames = new Set([
  "f",
  "filter",
  "fl",
  "lzw",
  "dct",
  "a85",
  "ahx",
  "ccf",
  "rl",
]);
const activeNames = new Set([
  "javascript",
  "js",
  "openaction",
  "aa",
  "launch",
  "embeddedfile",
  "filespec",
  "richmedia",
  "xfa",
  "acroform",
  "uri",
  "gotor",
  "submitform",
  "rendition",
  "fontfile",
  "fontfile2",
  "fontfile3",
]);
function whitespace(character: string): boolean {
  const point = character.charCodeAt(0);
  return point <= 32;
}
/** Conservative lexical feature guard, not a PDF parser or decompressor. */
function preflight(
  bytes: Uint8Array,
  limits: Readonly<DocumentLimits>,
): DocumentCode | null {
  if (bytes.length > limits.bytes) return "byte_limit";
  const source = new TextDecoder("latin1").decode(bytes);
  if (!source.startsWith("%PDF-") || !source.trimEnd().endsWith("%%EOF"))
    return "malformed_pdf";
  let nesting = 0;
  let tokens = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (!character) break;
    if (whitespace(character)) continue;
    tokens++;
    if (tokens > Math.min(100000, limits.textCharacters * 4))
      return "text_limit";
    if (
      character === "[" ||
      (character === "<" && source[cursor + 1] === "<")
    ) {
      nesting++;
      if (nesting > limits.depth) return "depth_limit";
    }
    if (character === "]" || (character === ">" && source[cursor + 1] === ">"))
      nesting = Math.max(0, nesting - 1);
    if (character !== "/") continue;
    const start = cursor + 1;
    cursor = start;
    while (
      cursor < source.length &&
      !whitespace(source[cursor] ?? " ") &&
      !"()<>[]{}/%".includes(source[cursor] ?? " ")
    )
      cursor++;
    const name = source
      .slice(start, cursor)
      .replace(/#([0-9a-f]{2})/gi, (_whole, code: string) =>
        String.fromCharCode(Number.parseInt(code, 16)),
      )
      .toLowerCase();
    cursor--;
    if (name === "encrypt") return "encrypted_pdf";
    if (
      filterNames.has(name) ||
      name === "objstm" ||
      name === "xref" ||
      name.endsWith("decode")
    )
      return "compressed_pdf";
    if (activeNames.has(name)) return "active_pdf";
  }
  return null;
}
function unsupported(code: DocumentCode): PdfTextResult {
  return {
    status: code.endsWith("limit")
      ? "incomplete"
      : code === "malformed_pdf"
        ? "unreadable"
        : "needs_review",
    code,
    parserVersion,
  };
}
export function createLocalPdfTextExtractor(): PdfTextExtractor {
  return {
    async extract(bytes, limits, signal) {
      if (signal?.aborted) return unsupported("canceled");
      const rejected = preflight(bytes, limits);
      if (rejected) return unsupported(rejected);
      let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
      let reader: ReadableStreamDefaultReader<unknown> | undefined;
      let canceled = false;
      const cancel = () => {
        canceled = true;
        void reader?.cancel().catch(() => {});
        void pdf?.loadingTask.destroy().catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        // Bytes only; no URL, renderer, font directory, external asset, or native canvas.
        pdf = await getDocumentProxy(new Uint8Array(bytes), {
          verbosity: 0,
          stopAtErrors: true,
          useWorkerFetch: false,
          useWasm: false,
          disableAutoFetch: true,
          disableStream: true,
          disableFontFace: true,
          useSystemFonts: true,
          maxImageSize: 0,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
          enableXfa: false,
        });
        if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1)
          return unsupported("malformed_pdf");
        if (pdf.numPages > limits.pages) return unsupported("page_limit");
        const pages: string[] = [];
        let characters = 0;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          if (canceled || signal?.aborted) return unsupported("canceled");
          const page = await pdf.getPage(pageNumber);
          reader = page
            .streamTextContent({ disableNormalization: true })
            .getReader();
          const pieces: string[] = [];
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const value = chunk.value as {
              items?: { str?: unknown; hasEOL?: boolean }[];
            };
            if (!Array.isArray(value.items))
              return unsupported("malformed_pdf");
            for (const item of value.items) {
              if (typeof item.str !== "string") continue;
              const text = item.str + (item.hasEOL ? "\n" : "");
              characters += text.length;
              if (characters > limits.textCharacters)
                return unsupported("text_limit");
              pieces.push(text);
            }
          }
          reader.releaseLock();
          reader = undefined;
          pages.push(pieces.join("").trim());
          page.cleanup();
        }
        if (canceled || signal?.aborted) return unsupported("canceled");
        if (pages.some((text) => text.length === 0))
          return unsupported("textless_pdf");
        return { status: "ready", pages, parserVersion };
      } catch {
        return unsupported(
          canceled || signal?.aborted ? "canceled" : "malformed_pdf",
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
        try {
          await reader?.cancel();
        } catch {
          /* No parser error or content leaves this boundary. */
        }
        try {
          await pdf?.loadingTask.destroy();
        } catch {
          /* Destruction is best effort after typed failure. */
        }
      }
    },
  };
}
