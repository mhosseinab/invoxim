import type { TenantContext } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeGmailDocumentInput } from "../../../packages/adapters/src/documents/gmail";
import { createLocalPdfTextExtractor } from "../../../packages/adapters/src/documents/pdf";
import { createDocumentTextExtractor } from "../../../packages/core/src/documents/extractor";
import type {
  DocumentInput,
  MimePart,
} from "../../../packages/core/src/documents/types";
import { DOCUMENT_LIMITS } from "../../../packages/core/src/documents/types";

const context = {
  tenant: { userId: "synthetic-doc-owner", authority: "job" } as TenantContext,
};
const bytes = (text: string) => new TextEncoder().encode(text);
const input = (root: MimePart): DocumentInput => ({
  connectionId: "synthetic-mailbox",
  providerMessageId: "synthetic-message",
  root,
});
afterEach(() => vi.restoreAllMocks());

it("DOCUMENT-04 rejects aggregate bytes before returning any extracted text", async () => {
  const result = await createDocumentTextExtractor().extract(
    input({
      partId: "",
      mimeType: "text/plain",
      bytes: new Uint8Array(DOCUMENT_LIMITS.bytes + 1),
    }),
    context,
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("byte_limit");
  expect(result.documents.every((document) => !("textParts" in document))).toBe(
    true,
  );
});
it("DOCUMENT-05 remote HTML remains inert while exact numeric receipt text is preserved", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected synthetic HTML network request");
  });
  const html =
    '<html><head><style>@import url(https://tracker.invalid/css); .x{background:url(https://tracker.invalid/pixel)}</style><script>FAKE PAID EUR 999.99; fetch("https://tracker.invalid/steal")</script></head><body><form>FAKE TOTAL 888.88</form><img src="https://tracker.invalid/pixel"><p>Subtotal EUR 100.00</p><p>Tax EUR 20.00</p><p>Total EUR 120.00</p><p>Paid EUR 120.00</p></body></html>';
  const result = await createDocumentTextExtractor().extract(
    input({ partId: "", mimeType: "text/html", bytes: bytes(html) }),
    context,
  );
  expect(result.status).toBe("ready");
  expect(result.documents).toHaveLength(1);
  const document = result.documents[0];
  expect(document?.identity.partId).toBe("");
  if (document?.status !== "ready")
    throw new Error("Missing inert document text");
  const text = document.textParts.map((part) => part.text).join("\n");
  for (const numeric of [
    "Subtotal EUR 100.00",
    "Tax EUR 20.00",
    "Total EUR 120.00",
    "Paid EUR 120.00",
  ])
    expect(text).toContain(numeric);
  expect(text).not.toMatch(/FAKE|tracker|fetch\(|<script|@import/);
});

it("DOCUMENT-01 body alternatives collapse without dropping independent invoice attachments", async () => {
  const result = await createDocumentTextExtractor().extract(
    input({
      partId: "",
      mimeType: "multipart/mixed",
      children: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          children: [
            {
              partId: "0.0",
              mimeType: "text/plain",
              bytes: bytes("Paid EUR 12.00"),
            },
            {
              partId: "0.1",
              mimeType: "text/html",
              bytes: bytes("<p>Paid EUR 12.00</p>"),
            },
          ],
        },
        {
          partId: "1",
          mimeType: "text/plain",
          disposition: "attachment",
          filename: "invoice-one.txt",
          bytes: bytes("Invoice ONE total EUR 12.00"),
        },
        {
          partId: "2",
          mimeType: "text/plain",
          disposition: "attachment",
          filename: "invoice-two.txt",
          bytes: bytes("Invoice TWO total EUR 24.00"),
        },
        {
          partId: "logo",
          mimeType: "image/png",
          disposition: "inline",
          filename: "logo.png",
          contentId: "logo",
          bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        },
      ],
    }),
    context,
  );
  expect(result.status).toBe("ready");
  expect(
    result.documents.filter((document) => document.role === "body"),
  ).toHaveLength(1);
  expect(result.ignoredPartIds).toContain("logo");
  const attachments = result.documents.filter(
    (document) => document.role === "attachment",
  );
  expect(
    attachments.map((document) => document.identity.partId).sort(),
  ).toEqual(["1", "2"]);
  for (const attachment of attachments) {
    expect(attachment.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment.status).toBe("ready");
  }
  expect(
    attachments.find((document) => document.identity.partId === "1")
      ?.contentHash,
  ).toBe("40bb5873ebf6f6a3f5bacf68e911edd40e32f8dd688aa7e7ab72cda0ee67ad45");
  expect(
    attachments.find((document) => document.identity.partId === "2")
      ?.contentHash,
  ).toBe("7ecc3b4791411b7b26df337f4c24ab03904a5f53d1bbab601ba7f06a254ff529");
});
it("DOCUMENT-04 rejects overly deep MIME before success", async () => {
  let root: MimePart = {
    partId: "leaf",
    mimeType: "text/plain",
    bytes: bytes("Paid EUR 12.00"),
  };
  for (let depth = 0; depth <= DOCUMENT_LIMITS.depth; depth++)
    root = {
      partId: `depth-${depth}`,
      mimeType: "multipart/mixed",
      children: [root],
    };
  const result = await createDocumentTextExtractor().extract(
    input(root),
    context,
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("depth_limit");
});
it("DOCUMENT-04 rejects excessive MIME node count instead of silently selecting the first invoice", async () => {
  const children: Array<MimePart> = Array.from(
    { length: DOCUMENT_LIMITS.parts },
    (_, index) => ({
      partId: `part-${index}`,
      mimeType: "text/plain",
      disposition: "attachment",
      bytes: bytes(`Invoice ${index} paid EUR 12.00`),
    }),
  );
  const result = await createDocumentTextExtractor().extract(
    input({ partId: "", mimeType: "multipart/mixed", children }),
    context,
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("part_limit");
});
it("DOCUMENT-06 truncating before the final paid total discards all partial evidence text", async () => {
  const result = await createDocumentTextExtractor({
    limits: { textCharacters: 80 },
  }).extract(
    input({
      partId: "",
      mimeType: "text/plain",
      bytes: bytes(
        `Subtotal EUR 10.00\n${"intermediate details ".repeat(20)}\nPaid total EUR 12.00`,
      ),
    }),
    context,
  );
  expect(result.status).toBe("incomplete");
  expect(result.code).toBe("text_limit");
  expect(result.documents.every((document) => !("textParts" in document))).toBe(
    true,
  );
});

function generatedPdf(pages: readonly (readonly string[])[]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pages.entries()) {
    const id = 4 + index * 2;
    const escaped = lines.map((line) =>
      line
        .replaceAll("\\", "\\\\")
        .replaceAll("(", "\\(")
        .replaceAll(")", "\\)"),
    );
    const stream = `BT /F1 12 Tf 50 750 Td ${escaped.map((line, lineIndex) => `${lineIndex ? "0 -18 Td " : ""}(${line}) Tj`).join("\n")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${bytes(stream).length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(bytes(source).length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = bytes(source).length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(source);
}
function pdfPart(
  partId: string,
  pages: readonly (readonly string[])[],
): MimePart {
  return {
    partId,
    mimeType: "application/pdf",
    disposition: "attachment",
    filename: `synthetic-${partId}.pdf`,
    bytes: generatedPdf(pages),
  };
}
it("DOCUMENT-02 actual local parser retains each page's subtotal/tax/gross/cash/credit numeric evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected PDF network destination");
  });
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(
    input(
      pdfPart("pdf-numeric", [
        ["Subtotal EUR 83.33", "Tax EUR 16.67"],
        [
          "Gross total EUR 100.00",
          "Paid by card EUR 70.00",
          "Store credit EUR 30.00",
        ],
      ]),
    ),
    context,
  );
  expect(result.status).toBe("ready");
  const document = result.documents[0];
  if (document?.status !== "ready")
    throw new Error("Actual numeric PDF missing");
  expect(document.parserVersion).toContain("unpdf-1.8.1");
  expect(document.pageCount).toBe(2);
  expect(document.textParts.map((part) => part.page)).toEqual([1, 2]);
  for (const value of ["Subtotal EUR 83.33", "Tax EUR 16.67"])
    expect(document.textParts[0]?.text).toContain(value);
  for (const value of [
    "Gross total EUR 100.00",
    "Paid by card EUR 70.00",
    "Store credit EUR 30.00",
  ])
    expect(document.textParts[1]?.text).toContain(value);
  expect(network).not.toHaveBeenCalled();
});
it("DOCUMENT-06 a final paid-total page beyond the page cap cannot expose first-page subtotal text", async () => {
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
    limits: { pages: 1 },
  }).extract(
    input(
      pdfPart("limited", [["Subtotal EUR 83.33"], ["Paid total EUR 100.00"]]),
    ),
    context,
  );
  expect(result).toMatchObject({
    status: "incomplete",
    code: "page_limit",
    documents: [],
  });
});
it("DOCUMENT-04 aggregate PDF pages across independent attachments share one bounded message budget", async () => {
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
    limits: { pages: 3 },
  }).extract(
    input({
      partId: "",
      mimeType: "multipart/mixed",
      children: [
        pdfPart("a", [
          ["Invoice A subtotal 10.00"],
          ["Invoice A paid total 12.00"],
        ]),
        pdfPart("b", [
          ["Invoice B subtotal 20.00"],
          ["Invoice B paid total 24.00"],
        ]),
      ],
    }),
    context,
  );
  expect(result).toMatchObject({
    status: "incomplete",
    code: "page_limit",
    documents: [],
  });
});
it("DOCUMENT-03 actual textless PDF is review rather than guessed OCR success", async () => {
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(input(pdfPart("textless", [[]])), context);
  expect(result.status).toBe("needs_review");
  expect(result.documents[0]).toMatchObject({
    status: "needs_review",
    code: "textless_pdf",
  });
  expect(result.documents.every((document) => !("textParts" in document))).toBe(
    true,
  );
});
it.each([
  ["/Filter /FlateDecode", "compressed_pdf"],
  ["/Encrypt", "encrypted_pdf"],
  ["/OpenAction /JavaScript", "active_pdf"],
] as const)(
  "DOCUMENT-03/04 conservative PDF feature guard rejects %s before unsafe processing",
  async (feature, code) => {
    const result = await createDocumentTextExtractor({
      pdf: createLocalPdfTextExtractor(),
    }).extract(
      input({
        partId: "guard",
        mimeType: "application/pdf",
        disposition: "attachment",
        bytes: bytes(
          `%PDF-1.4\n${feature}\n${"synthetic compressed payload ".repeat(1000)}\n%%EOF`,
        ),
      }),
      context,
    );
    expect(result.status).toBe("needs_review");
    expect(result.documents[0]).toMatchObject({ status: "needs_review", code });
    expect(
      result.documents.every((document) => !("textParts" in document)),
    ).toBe(true);
  },
);
it("DOCUMENT-01 Gmail attachment lookup preserves provider identity and exact supplied original bytes", async () => {
  const original = bytes("Invoice ONE total EUR 12.00");
  const encoded = btoa(String.fromCharCode(...original))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const normalized = normalizeGmailDocumentInput({
    connectionId: "synthetic-mailbox",
    providerMessageId: "synthetic-message",
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "provider-exact-part",
          mimeType: "text/plain",
          filename: "invoice.txt",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: {
            size: original.byteLength,
            attachmentId: "provider-attachment",
          },
        },
      ],
    },
    attachments: new Map([
      ["provider-attachment", { size: original.byteLength, data: encoded }],
    ]),
  });
  if (normalized.status !== "ready")
    throw new Error("Supplied Gmail attachment unavailable");
  expect(normalized.input.root.children?.[0]?.partId).toBe(
    "provider-exact-part",
  );
  expect(normalized.input.root.children?.[0]?.bytes).toEqual(original);
  const result = await createDocumentTextExtractor().extract(
    normalized.input,
    context,
  );
  expect(result.documents[0]).toMatchObject({
    identity: { partId: "provider-exact-part" },
    contentHash:
      "40bb5873ebf6f6a3f5bacf68e911edd40e32f8dd688aa7e7ab72cda0ee67ad45",
    status: "ready",
  });
});
it("DOCUMENT-04 declared Gmail size mismatch cannot silently truncate or replace original bytes", () => {
  const normalized = normalizeGmailDocumentInput({
    connectionId: "synthetic-mailbox",
    providerMessageId: "synthetic-message",
    payload: {
      partId: "",
      mimeType: "text/plain",
      body: { size: 100, data: "UGFpZCBFVVIgMTIuMDA" },
    },
  });
  expect(normalized).toMatchObject({
    status: "unreadable",
    code: "invalid_encoding",
  });
});
