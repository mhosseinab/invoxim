import type {
  DocumentCode,
  DocumentLimits,
  PdfTextExtractor,
  PdfTextResult,
} from "@invoxim/core";
import { type getDocumentProxy, getResolvedPDFJS } from "unpdf";

import { LOCAL_PDF_PARSER_VERSION, preflightPdf } from "./pdf-preflight";

export { LOCAL_PDF_PARSER_VERSION } from "./pdf-preflight";

const parserVersion = LOCAL_PDF_PARSER_VERSION;
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
async function extractPdf(
  bytes: Uint8Array,
  limits: Readonly<DocumentLimits>,
  signal: AbortSignal,
): Promise<PdfTextResult> {
  if (signal?.aborted) return unsupported("canceled");
  const rejected = await preflightPdf(bytes, limits, signal);
  if (rejected) return unsupported(rejected);
  const deadline = Date.now() + 10000;
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  let loadingTask: { destroy(): Promise<void> } | undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let canceled = false;
  const cancel = () => {
    canceled = true;
    void loadingTask?.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Bytes only; no URL, renderer, font directory, external asset, or native canvas.
    const { getDocument } = await getResolvedPDFJS();
    if (signal.aborted) return unsupported("canceled");
    const task = getDocument({
      data: new Uint8Array(bytes),
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
    loadingTask = task;
    pdf = await task.promise;
    if (Date.now() > deadline) return unsupported("converter_unavailable");
    if (canceled || signal.aborted) return unsupported("canceled");
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1)
      return unsupported("malformed_pdf");
    if (pdf.numPages > limits.pages) return unsupported("page_limit");
    const pages: string[] = [];
    let characters = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (canceled || signal?.aborted) return unsupported("canceled");
      const page = await pdf.getPage(pageNumber);
      if (Date.now() > deadline) return unsupported("converter_unavailable");
      reader = page
        .streamTextContent({ disableNormalization: true })
        .getReader();
      const pieces: string[] = [];
      while (true) {
        const chunk = await reader.read();
        if (Date.now() > deadline) return unsupported("converter_unavailable");
        if (canceled || signal.aborted) return unsupported("canceled");
        if (chunk.done) break;
        const value = chunk.value as {
          items?: { str?: unknown; hasEOL?: boolean }[];
        };
        if (!Array.isArray(value.items)) return unsupported("malformed_pdf");
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
      await loadingTask?.destroy();
    } catch {
      /* Destruction is best effort after typed failure. */
    }
  }
}

export function createLocalPdfTextExtractor(): PdfTextExtractor {
  return {
    async extract(bytes, limits, signal) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(cancel, 10000);
      try {
        return await extractPdf(bytes, limits, controller.signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
