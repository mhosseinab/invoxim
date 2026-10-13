import { expect, it, vi } from "vitest";
import { createDocumentTextExtractor } from "../src/documents/extractor";
import type { DocumentContext, DocumentInput } from "../src/documents/types";
import type { TenantContext } from "../src/tenant-context";

const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
const context = { tenant, inputMode: "direct-model" } as DocumentContext;
const bytes = (text: string) => new TextEncoder().encode(text);
const plain = "Thank you. Receipt date 2026-10-14; paid EUR 42.00.";
const html =
  '<html><head><title>Receipt</title></head><body><p>Paid EUR 42.00</p><script>fetch("https://tracker.invalid")</script><img src="https://tracker.invalid/pixel"></body></html>';
function input(): DocumentInput {
  return {
    connectionId: "synthetic-mailbox",
    providerMessageId: "synthetic-message",
    root: {
      partId: "",
      mimeType: "multipart/alternative",
      children: [
        { partId: "plain", mimeType: "text/plain", bytes: bytes(plain) },
        { partId: "html", mimeType: "text/html", bytes: bytes(html) },
      ],
    },
  };
}
it("direct input preserves original HTML and plain alternatives as one labeled model document without fetching assets", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const result = await createDocumentTextExtractor().extract(
      input(),
      context,
    );
    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0];
    if (doc?.status !== "ready") throw new Error("not ready");
    expect(doc.identity.partId).toBe("");
    expect(doc.parserVersion).toBe("documents-direct-v1");
    expect(doc.textParts).toEqual([
      { page: null, text: plain, partId: "plain", mimeType: "text/plain" },
      { page: null, text: html, partId: "html", mimeType: "text/html" },
    ]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
it("direct plain text and HTML attachments stay byte faithful", async () => {
  for (const mimeType of ["text/plain", "text/html"]) {
    const text = mimeType === "text/html" ? html : plain;
    const result = await createDocumentTextExtractor().extract(
      {
        ...input(),
        root: {
          partId: "invoice",
          mimeType,
          filename: "invoice",
          disposition: "attachment",
          bytes: bytes(text),
        },
      },
      context,
    );
    const doc = result.documents[0];
    if (doc?.status !== "ready") throw new Error("not ready");
    expect(doc.textParts[0]?.text).toBe(text);
    expect(doc.role).toBe("attachment");
    expect(doc.parserVersion).toBe("documents-direct-v1");
  }
});
it("combined alternatives honor aggregate text bounds without partial model input", async () => {
  const result = await createDocumentTextExtractor({
    limits: { textCharacters: plain.length + html.length - 1 },
  }).extract(input(), context);
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("text_limit");
  expect(result.documents).toEqual([]);
});
it("direct mode never invokes a PDF converter and legacy mode remains available", async () => {
  const pdf = vi.fn(async () => ({
    status: "ready" as const,
    pages: ["Synthetic receipt"],
    parserVersion: "synthetic",
  }));
  const extractor = createDocumentTextExtractor({ pdf: { extract: pdf } });
  const result = await extractor.extract(
    {
      ...input(),
      root: {
        partId: "invoice",
        mimeType: "application/pdf",
        bytes: bytes("%PDF-synthetic"),
      },
    },
    context,
  );
  expect(pdf).not.toHaveBeenCalled();
  expect(result.documents[0]).toMatchObject({
    status: "needs_review",
    code: "converter_unavailable",
  });
  const legacy = await extractor.extract(input(), {
    tenant,
    bodyAlternative: "legacy-plain",
  });
  const doc = legacy.documents[0];
  if (doc?.status !== "ready") throw new Error("not ready");
  expect(doc.parserVersion).toBe("documents-v1");
  expect(doc.textParts).toEqual([{ page: null, text: plain }]);
});
it("direct grouped content hashes are stable and change when either alternative changes", async () => {
  const extractor = createDocumentTextExtractor();
  const first = await extractor.extract(input(), context);
  const same = await extractor.extract(input(), context);
  expect(first.documents[0]?.contentHash).toBe(same.documents[0]?.contentHash);
  const changed = input();
  const htmlPart = changed.root.children?.[1];
  if (!htmlPart) throw new Error("missing fixture");
  htmlPart.bytes = bytes(`${html} `);
  const result = await extractor.extract(changed, context);
  expect(result.documents[0]?.contentHash).not.toBe(
    first.documents[0]?.contentHash,
  );
});

it("direct mode preserves MIME signature and aggregate byte guards", async () => {
  const disguised = await createDocumentTextExtractor().extract(
    {
      ...input(),
      root: {
        partId: "",
        mimeType: "text/html",
        bytes: bytes("%PDF-hidden binary"),
      },
    },
    context,
  );
  expect(disguised.status).toBe("unreadable");
  expect(disguised.documents).toEqual([]);
  expect(disguised.code).toBe("invalid_mime");
  const limited = await createDocumentTextExtractor({
    limits: { bytes: plain.length + html.length - 1 },
  }).extract(input(), context);
  expect(limited.status).toBe("incomplete");
  expect(limited.code).toBe("byte_limit");
  expect(limited.documents).toEqual([]);
});
it("invalid encoding in a grouped body never returns only the remaining alternative as complete input", async () => {
  const malformed = input();
  const part = malformed.root.children?.[1];
  if (!part) throw new Error("missing fixture");
  part.bytes = new Uint8Array([255]);
  const result = await createDocumentTextExtractor().extract(
    malformed,
    context,
  );
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]).toMatchObject({
    status: "unreadable",
    code: "invalid_encoding",
  });
  expect(result.documents[0]).not.toHaveProperty("textParts");
});
