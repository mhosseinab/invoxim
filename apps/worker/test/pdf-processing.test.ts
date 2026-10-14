import { DOCUMENT_LIMITS, type TenantContext } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import { createLocalPdfTextExtractor } from "../../../packages/adapters/src/documents/pdf";
import { createDocumentTextExtractor } from "../../../packages/core/src/documents/extractor";
import {
  generateCompressedTextPdf,
  generateTextPdf,
} from "./fixtures/synthetic-pdf";

const tenant = {
  userId: "synthetic-pdf-processing",
  authority: "job",
} as TenantContext;
it("PDF-PROCESSING-01: ordinary Flate invoice preserves date, decimal amount and independent lines", async () => {
  const bytes = await generateCompressedTextPdf(
    "Rechnung Nr. 2026-104 | Rechnungsdatum 14.10.2026 | Gesamt EUR 123,45",
  );
  const result = await createLocalPdfTextExtractor().extract(
    bytes,
    DOCUMENT_LIMITS,
  );
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Synthetic compressed invoice unavailable");
  expect(result.pages.join("\n")).toContain("Rechnungsdatum 14.10.2026");
  expect(result.pages.join("\n")).toContain("Gesamt EUR 123,45");
});
it("PDF-PROCESSING-02: direct-model input converts PDF while preserving exact source identity and body HTML", async () => {
  const pdf = generateTextPdf([
    ["Rechnung", "Datum 14.10.2026", "Gesamt EUR 123,45"],
  ]);
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(
    {
      connectionId: "synthetic-connection",
      providerMessageId: "synthetic-message",
      root: {
        partId: "root",
        mimeType: "multipart/mixed",
        children: [
          {
            partId: "body",
            mimeType: "text/html",
            bytes: new TextEncoder().encode("<p>Invoice attached</p>"),
          },
          {
            partId: "invoice",
            mimeType: "application/pdf",
            filename: "rechnung.pdf",
            bytes: pdf,
          },
        ],
      },
    },
    { tenant, inputMode: "direct-model" },
  );
  expect(result.status).toBe("ready");
  expect(result.documents[0]).toMatchObject({
    status: "ready",
    textParts: [
      {
        page: null,
        text: "<p>Invoice attached</p>",
        partId: "body",
        mimeType: "text/html",
      },
    ],
  });
  expect(result.documents[1]).toMatchObject({
    status: "ready",
    identity: { partId: "invoice" },
    pageCount: 1,
    textParts: [
      { page: 1, text: "Rechnung\nDatum 14.10.2026\nGesamt EUR 123,45" },
    ],
  });
});

it("PDF-PROCESSING-03: embedded compressed font and indirect length retain realistic invoice lines without network", async () => {
  const { embeddedInvoicePdf } =
    await import("./fixtures/synthetic-embedded-pdf");
  const result = await createLocalPdfTextExtractor().extract(
    embeddedInvoicePdf(),
    DOCUMENT_LIMITS,
  );
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Synthetic embedded-font invoice unavailable");
  expect(result.pages[0]).toContain("Händler: Synthetischer Büro Shop");
  expect(result.pages[0]).toContain("Rechnungsdatum: 14.10.2026");
  expect(result.pages[0]).toContain(
    "Netto EUR 102,88\nUmsatzsteuer EUR 20,57\nGesamt EUR 123,45",
  );
});

it("PDF-PROCESSING-04: compression bomb fails closed before text extraction", async () => {
  const bytes = await generateCompressedTextPdf("A".repeat(1024 * 1024));
  const result = await createLocalPdfTextExtractor().extract(
    bytes,
    DOCUMENT_LIMITS,
  );
  expect(result).toMatchObject({
    status: "needs_review",
    code: "compressed_pdf",
  });
  expect("pages" in result).toBe(false);
});
it("PDF-PROCESSING-05: malformed deflate bytes cannot expose partial invoice text", async () => {
  const bytes = await generateCompressedTextPdf("Invoice total EUR 123.45");
  const header =
    new TextDecoder("latin1").decode(bytes).indexOf("stream\n") + 7;
  bytes[header] = 0;
  expect(
    await createLocalPdfTextExtractor().extract(bytes, DOCUMENT_LIMITS),
  ).toMatchObject({ status: "unreadable", code: "malformed_pdf" });
});
it("PDF-PROCESSING-06: byte, page and text bounds retain no partial PDF content", async () => {
  const bytes = generateTextPdf([
    ["Subtotal EUR 100.00"],
    ["Final total EUR 120.00"],
  ]);
  for (const [limits, code] of [
    [{ bytes: bytes.length - 1 }, "byte_limit"],
    [{ pages: 1 }, "page_limit"],
    [{ textCharacters: 5 }, "text_limit"],
  ] as const) {
    const result = await createLocalPdfTextExtractor().extract(bytes, {
      ...DOCUMENT_LIMITS,
      ...limits,
    });
    expect(result).toMatchObject({ status: "incomplete", code });
    expect("pages" in result).toBe(false);
  }
});
it("PDF-PROCESSING-07: pre-abort and mid-decompression cancellation return typed outcomes", async () => {
  const bytes = await generateCompressedTextPdf("Synthetic invoice EUR 123.45");
  for (const before of [true, false]) {
    const controller = new AbortController();
    if (before) controller.abort();
    const pending = createLocalPdfTextExtractor().extract(
      bytes,
      DOCUMENT_LIMITS,
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({
      status: "needs_review",
      code: "canceled",
    });
  }
});
it("PDF-PROCESSING-08: direct-model PDF aggregate page limits hide all partial message evidence", async () => {
  const bytes = generateTextPdf([["Invoice EUR 100.00"]]);
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
    limits: { pages: 1 },
  }).extract(
    {
      connectionId: "synthetic-connection",
      providerMessageId: "aggregate-pdf",
      root: {
        partId: "root",
        mimeType: "multipart/mixed",
        children: [
          { partId: "a", mimeType: "application/pdf", bytes },
          { partId: "b", mimeType: "application/pdf", bytes },
        ],
      },
    },
    { tenant, inputMode: "direct-model" },
  );
  expect(result).toMatchObject({
    status: "incomplete",
    code: "page_limit",
    documents: [],
  });
});
it("PDF-PROCESSING-09: converted PDF hash changes with original bytes and preserves provider part ID", async () => {
  const extractor = createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  });
  const hashes = [];
  for (const value of ["Invoice EUR 123.45", "Invoice EUR 123.46"]) {
    const result = await extractor.extract(
      {
        connectionId: "synthetic-connection",
        providerMessageId: "same-source",
        root: {
          partId: "unchanged-part",
          mimeType: "application/pdf",
          bytes: await generateCompressedTextPdf(value),
        },
      },
      { tenant, inputMode: "direct-model" },
    );
    expect(result.documents[0]).toMatchObject({
      status: "ready",
      identity: { partId: "unchanged-part" },
      parserVersion: "documents-direct-pdf-v2/unpdf-1.8.1/bounded-flate-v2",
    });
    hashes.push(result.documents[0]?.contentHash);
  }
  expect(hashes[0]).not.toBe(hashes[1]);
});
it("PDF-PROCESSING-10: no parser network access occurs for an embedded-font invoice", async () => {
  const { embeddedInvoicePdf } =
    await import("./fixtures/synthetic-embedded-pdf");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
  try {
    expect(
      (
        await createLocalPdfTextExtractor().extract(
          embeddedInvoicePdf(),
          DOCUMENT_LIMITS,
        )
      ).status,
    ).toBe("ready");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("PDF-PROCESSING-11: passive receipt hyperlinks stay inert while active JavaScript actions fail closed", async () => {
  const { generateLinkedInvoicePdf } = await import("./fixtures/synthetic-pdf");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
  try {
    expect(
      (
        await createLocalPdfTextExtractor().extract(
          generateLinkedInvoicePdf(),
          DOCUMENT_LIMITS,
        )
      ).status,
    ).toBe("ready");
    expect(
      await createLocalPdfTextExtractor().extract(
        generateLinkedInvoicePdf("/JS (app.alert('bad'))"),
        DOCUMENT_LIMITS,
      ),
    ).toMatchObject({ code: "active_pdf" });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("PDF-PROCESSING-12: decompression deadline fails typed without leaking partial text", async () => {
  const bytes = await generateCompressedTextPdf("Invoice total EUR 123.45");
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(10001);
  try {
    expect(
      await createLocalPdfTextExtractor().extract(bytes, DOCUMENT_LIMITS),
    ).toMatchObject({ status: "needs_review", code: "converter_unavailable" });
  } finally {
    clock.mockRestore();
  }
});
it("PDF-PROCESSING-13: direct converter output cannot return blank pages", async () => {
  for (const pages of [[""], [" "]]) {
    const result = await createDocumentTextExtractor({
      pdf: {
        async extract() {
          return { status: "ready", pages, parserVersion: "synthetic" };
        },
      },
    }).extract(
      {
        connectionId: "synthetic-connection",
        providerMessageId: "synthetic-message",
        root: {
          partId: "pdf",
          mimeType: "application/pdf",
          bytes: generateTextPdf([["Invoice EUR 123.45"]]),
        },
      },
      { tenant, inputMode: "direct-model" },
    );
    expect(result.documents[0]).toMatchObject({
      status: "needs_review",
      code: "textless_pdf",
    });
    expect(
      result.documents.every((document) => !("textParts" in document)),
    ).toBe(true);
  }
});

it("PDF-PROCESSING-14: body plus PDF shares the same aggregate text allowance", async () => {
  const result = await createDocumentTextExtractor({
    limits: { textCharacters: 150 },
    pdf: {
      async extract() {
        return {
          status: "ready",
          pages: ["B".repeat(100)],
          parserVersion: "synthetic",
        };
      },
    },
  }).extract(
    {
      connectionId: "synthetic-connection",
      providerMessageId: "synthetic-message",
      root: {
        partId: "root",
        mimeType: "multipart/mixed",
        children: [
          {
            partId: "body",
            mimeType: "text/plain",
            bytes: new TextEncoder().encode("A".repeat(80)),
          },
          {
            partId: "pdf",
            mimeType: "application/pdf",
            bytes: generateTextPdf([["Invoice EUR 123.45"]]),
          },
        ],
      },
    },
    { tenant, inputMode: "direct-model" },
  );
  expect(result).toMatchObject({
    status: "incomplete",
    code: "text_limit",
    documents: [],
  });
});

it.each(["/Prev", "/XRefStm", "/P#72ev", "/XRef#53tm"] as const)(
  "PDF-PROCESSING-15: secondary xref chain %s is refused before PDF.js",
  async (feature) => {
    const { preflightPdf } =
      await import("../../../packages/adapters/src/documents/pdf-preflight");
    const { generateSecondaryXrefPdf } =
      await import("./fixtures/synthetic-pdf");
    expect(
      await preflightPdf(generateSecondaryXrefPdf(feature), DOCUMENT_LIMITS),
    ).toBe("compressed_pdf");
  },
);

it("PDF-PROCESSING-16: small object-heavy PDFs fail the structural resource bound", async () => {
  const { preflightPdf } =
    await import("../../../packages/adapters/src/documents/pdf-preflight");
  const { generateObjectHeavyPdf } = await import("./fixtures/synthetic-pdf");
  const bytes = generateObjectHeavyPdf();
  expect(bytes.byteLength).toBeLessThan(DOCUMENT_LIMITS.bytes);
  expect(await preflightPdf(bytes, DOCUMENT_LIMITS)).toBe("part_limit");
});

it("PDF-PROCESSING-17: malformed classic xref entries fail closed instead of triggering PDF.js recovery", async () => {
  const { preflightPdf } =
    await import("../../../packages/adapters/src/documents/pdf-preflight");
  const source = new TextDecoder().decode(
    generateTextPdf([["Invoice EUR 123.45"]]),
  );
  const malformed = source.replace(
    /^\d{10} \d{5} [nf] /gm,
    "invalid-xref-entry ",
  );
  expect(
    await preflightPdf(new TextEncoder().encode(malformed), DOCUMENT_LIMITS),
  ).toBe("malformed_pdf");
});

it.each([false, true])(
  "PDF-PROCESSING-18: literal or opaque indirect Length decoys cannot choose the checked range (indirect=%s)",
  async (indirect) => {
    const { preflightPdf } =
      await import("../../../packages/adapters/src/documents/pdf-preflight");
    const { generateLengthDecoyPdf } = await import("./fixtures/synthetic-pdf");
    expect(
      await preflightPdf(generateLengthDecoyPdf(indirect), DOCUMENT_LIMITS),
    ).toBe(indirect ? "malformed_pdf" : "compressed_pdf");
  },
);

it("PDF-PROCESSING-19: trailer scalar authority cannot be substituted by a comment or literal string", async () => {
  const { preflightPdf } =
    await import("../../../packages/adapters/src/documents/pdf-preflight");
  const source = new TextDecoder().decode(
    generateTextPdf([["Invoice EUR 123.45"]]),
  );
  for (const replacement of [
    "/Decoy (/Size 7) /S#69ze 999999999",
    "% /Size 7\n/S#69ze 999999999",
  ]) {
    const malformed = source.replace(/\/Size \d+/, replacement);
    expect(
      await preflightPdf(new TextEncoder().encode(malformed), DOCUMENT_LIMITS),
    ).toBe("compressed_pdf");
  }
});

it.each([
  "nested-length",
  "invalid-root",
  "invalid-pages",
  "unclaimed-stream",
] as const)(
  "PDF-PROCESSING-20: strict subset refuses %s before PDF.js recovery or unchecked conversion",
  async (kind) => {
    const { preflightPdf } =
      await import("../../../packages/adapters/src/documents/pdf-preflight");
    const { generatePdfGateRegression } =
      await import("./fixtures/synthetic-pdf");
    expect(
      await preflightPdf(generatePdfGateRegression(kind), DOCUMENT_LIMITS),
    ).not.toBeNull();
  },
);
