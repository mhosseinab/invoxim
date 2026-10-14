import type { TenantContext } from "@invoxim/core";
import { expect, it } from "vitest";
import { createDocumentTextExtractor } from "../../../packages/core/src/documents/extractor";

const tenant = {
  userId: "synthetic-documents",
  authority: "job",
} as TenantContext;
it("DOCUMENT-05: inert HTML retains numeric receipt text without fetching scripts or tracking pixels", async () => {
  const extractor = createDocumentTextExtractor();
  const result = await extractor.extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "synthetic-message",
      root: {
        partId: "0",
        mimeType: "text/html",
        bytes: new TextEncoder().encode(
          '<script>fetch("https://synthetic.invalid/tracker")</script><style>@import "https://synthetic.invalid/asset";</style><img src="https://synthetic.invalid/pixel"><p>Paid EUR 12.34</p>',
        ),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("ready");
  expect(result.documents).toHaveLength(1);
  const document = result.documents[0];
  expect(document?.status).toBe("ready");
  if (document?.status !== "ready")
    throw new Error("synthetic document not ready");
  expect(document.textParts.map((part) => part.text).join("\n")).toBe(
    "Paid EUR 12.34",
  );
});

it("DOCUMENT-02: real generated two-page PDF retains subtotal/tax and final paid evidence exactly", async () => {
  const { generateTextPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const { createLocalPdfTextExtractor } =
    await import("../../../packages/adapters/src/documents/pdf");
  const extractor = createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  });
  const result = await extractor.extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "numeric-pdf",
      root: {
        partId: "2",
        mimeType: "application/pdf",
        filename: "synthetic.pdf",
        disposition: "attachment",
        bytes: generateTextPdf([
          ["Subtotal EUR 100.00", "Tax EUR 20.00"],
          ["Total EUR 120.00", "Paid by card EUR 120.00"],
        ]),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("ready");
  const document = result.documents[0];
  expect(document?.status).toBe("ready");
  if (document?.status !== "ready") throw new Error("synthetic PDF not ready");
  expect(document.pageCount).toBe(2);
  expect(document.textParts[0]?.text).toContain("Subtotal EUR 100.00");
  expect(document.textParts[0]?.text).toContain("Tax EUR 20.00");
  expect(document.textParts[1]?.text).toContain("Total EUR 120.00");
  expect(document.textParts[1]?.text).toContain("Paid by card EUR 120.00");
});

it("DOCUMENT-04: Gmail content rejects malformed padding and nonzero base64url pad bits", async () => {
  const { normalizeGmailDocumentInput } =
    await import("../../../packages/adapters/src/documents/gmail");
  for (const [data, size] of [
    ["AA=", 1],
    ["AAA==", 2],
    ["AB", 1],
  ] as const) {
    expect(
      normalizeGmailDocumentInput({
        connectionId: "synthetic-mailbox",
        providerMessageId: "invalid-base64",
        payload: { partId: "", mimeType: "text/plain", body: { size, data } },
      }),
    ).toEqual({ status: "unreadable", code: "invalid_encoding" });
  }
});

it("DOCUMENT-05: nested hidden forms and fake script closing prefixes do not become numeric evidence", async () => {
  const html =
    '<head><script>const x="</head>"; FAKE EUR 800;</script></head><form><form>FAKE EUR 900</form>FAKE EUR 901</form><script>FAKE</scripted>FAKE EUR 902</script><p>Paid EUR 12.34</p>';
  const result = await createDocumentTextExtractor().extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "nested-html",
      root: {
        partId: "",
        mimeType: "text/html",
        bytes: new TextEncoder().encode(html),
      },
    },
    { tenant },
  );
  const document = result.documents[0];
  expect(document?.status).toBe("ready");
  if (document?.status !== "ready") throw new Error("synthetic HTML not ready");
  expect(document.textParts.map((part) => part.text).join("\n")).toBe(
    "Paid EUR 12.34",
  );
});

it("DOCUMENT-04: a real PDF mislabelled plain text never returns its syntax as receipt evidence", async () => {
  const { generateTextPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const result = await createDocumentTextExtractor().extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "spoofed-pdf",
      root: {
        partId: "",
        mimeType: "text/plain",
        bytes: generateTextPdf([["Paid EUR 12.34"]]),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("unreadable");
  expect(result.documents.every((document) => !("textParts" in document))).toBe(
    true,
  );
});
it("DOCUMENT-03: a swappable converter cannot claim ready with empty or whitespace-only PDF pages", async () => {
  for (const pages of [[], [""], ["   "]] as string[][]) {
    const result = await createDocumentTextExtractor({
      pdf: {
        async extract() {
          return {
            status: "ready",
            pages,
            parserVersion: "synthetic-empty-converter",
          };
        },
      },
    }).extract(
      {
        connectionId: "synthetic-mailbox",
        providerMessageId: "empty-pdf-port",
        root: {
          partId: "0",
          mimeType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.4 synthetic"),
        },
      },
      { tenant },
    );
    expect(result.status).toBe("needs_review");
    expect(result.documents[0]?.status).toBe("needs_review");
    const document = result.documents[0];
    expect(document && "code" in document ? document.code : null).toBe(
      "textless_pdf",
    );
  }
});

it("DOCUMENT-03: a real generated image-only PDF requires review without invented OCR", async () => {
  const { generateImageOnlyPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const { createLocalPdfTextExtractor } =
    await import("../../../packages/adapters/src/documents/pdf");
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "image-only-pdf",
      root: {
        partId: "",
        mimeType: "application/pdf",
        bytes: generateImageOnlyPdf(),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("needs_review");
  const document = result.documents[0];
  expect(document && "code" in document ? document.code : null).toBe(
    "textless_pdf",
  );
  expect(document && "textParts" in document).toBe(false);
});
it("DOCUMENT-04: a real small compressed PDF with a large expanded stream is rejected before conversion", async () => {
  const { generateCompressedTextPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const { createLocalPdfTextExtractor } =
    await import("../../../packages/adapters/src/documents/pdf");
  const bytes = await generateCompressedTextPdf("A".repeat(1024 * 1024));
  expect(bytes.length).toBeLessThan(8192);
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "compressed-pdf",
      root: { partId: "", mimeType: "application/pdf", bytes },
    },
    { tenant },
  );
  const document = result.documents[0];
  expect(document && "code" in document ? document.code : null).toBe(
    "compressed_pdf",
  );
  expect(document && "textParts" in document).toBe(false);
});
it("DOCUMENT-04: PDF page allowance is aggregate across attachments, with no partial text on overflow", async () => {
  const { generateTextPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const { createLocalPdfTextExtractor } =
    await import("../../../packages/adapters/src/documents/pdf");
  const bytes = generateTextPdf([["Paid EUR 12.34"]]);
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
    limits: { pages: 1 },
  }).extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "aggregate-pages",
      root: {
        partId: "",
        mimeType: "multipart/mixed",
        children: [
          { partId: "0", mimeType: "application/pdf", bytes },
          { partId: "1", mimeType: "application/pdf", bytes },
        ],
      },
    },
    { tenant },
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("page_limit");
  expect(result.documents).toEqual([]);
});

it("DOCUMENT-04: an actual deflated inline-image PDF using /F /Fl is rejected before PDF.js", async () => {
  const { generateTextPdf } =
    await import("../../../packages/testkit/src/pdf/synthetic");
  const { createLocalPdfTextExtractor } =
    await import("../../../packages/adapters/src/documents/pdf");
  // Rewrite only this known synthetic generator output, never production document bytes.
  const original = new TextDecoder().decode(
    generateTextPdf([["Paid EUR 12.34"]]),
  );
  const contentStart = original.indexOf("stream\n") + "stream\n".length;
  const contentEnd = original.indexOf("\nendstream", contentStart);
  const originalStream = original.slice(contentStart, contentEnd);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([Uint8Array.from([65, 65, 65])])
        .stream()
        .pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const inline = `q BI /W 1 /H 1 /BPC 8 /CS /RGB /F /Fl ID ${String.fromCharCode(...compressed)} EI Q\n`;
  const stream = inline + originalStream;
  const prefix = original
    .slice(0, contentStart)
    .replace(`/Length ${originalStream.length}`, `/Length ${stream.length}`);
  const body =
    prefix + stream + original.slice(contentEnd, original.indexOf("xref\n"));
  const offsets = [...body.matchAll(/([0-9]+) 0 obj/g)].map(
    (match) => match.index,
  );
  const footer = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`;
  const bytes = Uint8Array.from(body + footer, (character) =>
    character.charCodeAt(0),
  );
  const result = await createLocalPdfTextExtractor().extract(bytes, {
    bytes: 4 * 1024 * 1024,
    parts: 64,
    depth: 8,
    pages: 20,
    textCharacters: 24000,
  });
  expect(result.status).toBe("needs_review");
  expect("code" in result ? result.code : null).toBe("compressed_pdf");
});

it("DOCUMENT-05: quoted closing-tag attributes never become payment evidence", async () => {
  const result = await createDocumentTextExtractor().extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "closing-attribute-html",
      root: {
        partId: "",
        mimeType: "text/html",
        bytes: new TextEncoder().encode(
          "<script>hidden</script attr='>Paid 999'>after<p>Paid 12</p>",
        ),
      },
    },
    { tenant },
  );
  expect(result.status).toBe("ready");
  const document = result.documents[0];
  if (document?.status !== "ready") throw new Error("Synthetic HTML not ready");
  const text = document.textParts.map((part) => part.text).join("\n");
  expect(text).toContain("Paid 12");
  expect(text).not.toContain("Paid 999");
});

it("DOCUMENT-04: oversized Gmail arrays are rejected before inspecting late elements", async () => {
  const { normalizeGmailDocumentInput } =
    await import("../../../packages/adapters/src/documents/gmail");
  const parts = Array.from({ length: 65 }, () => ({
    partId: "0",
    mimeType: "text/plain",
    body: { size: 0, data: "" },
  }));
  Object.defineProperty(parts, 64, {
    get() {
      throw new Error("Oversized part traversed");
    },
  });
  expect(
    normalizeGmailDocumentInput({
      connectionId: "synthetic-mailbox",
      providerMessageId: "oversized-parts",
      payload: { partId: "", mimeType: "multipart/mixed", parts },
    }),
  ).toEqual({ status: "incomplete", code: "part_limit" });
  const headers = Array.from({ length: 65 }, () => ({
    name: "X-Synthetic",
    value: "bounded",
  }));
  Object.defineProperty(headers, 64, {
    get() {
      throw new Error("Oversized header traversed");
    },
  });
  expect(
    normalizeGmailDocumentInput({
      connectionId: "synthetic-mailbox",
      providerMessageId: "oversized-headers",
      payload: {
        partId: "",
        mimeType: "text/plain",
        body: { size: 0, data: "" },
        headers,
      },
    }),
  ).toEqual({ status: "unreadable", code: "invalid_mime" });
});

it("DOCUMENT-03: unnamed images without inline evidence remain explicit review documents", async () => {
  for (const mimeType of ["image/png", "image/jpeg"]) {
    const result = await createDocumentTextExtractor().extract(
      {
        connectionId: "synthetic-mailbox",
        providerMessageId: "unnamed-image",
        root: { partId: "", mimeType, bytes: Uint8Array.from([1, 2, 3]) },
      },
      { tenant },
    );
    expect(result.status).toBe("needs_review");
    expect(result.documents).toHaveLength(1);
    const document = result.documents[0];
    expect(document?.identity.partId).toBe("");
    expect(document?.status).toBe("needs_review");
    expect(document && "code" in document ? document.code : null).toBe(
      "image_requires_verified_parser",
    );
  }
});
