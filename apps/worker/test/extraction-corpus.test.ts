import {
  createDocumentTextExtractor,
  parseMoney,
  type TenantContext,
} from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalPdfTextExtractor } from "../../../packages/adapters/src/documents/pdf";
import cleanPdf from "../../../packages/testkit/src/extraction-corpus/assets/clean-two-page.pdf?inline";
import compressedPdf from "../../../packages/testkit/src/extraction-corpus/assets/compressed-text.pdf?inline";
import jpeg from "../../../packages/testkit/src/extraction-corpus/assets/probe.jpg?inline";
import png from "../../../packages/testkit/src/extraction-corpus/assets/probe.png?inline";
import scannedPdf from "../../../packages/testkit/src/extraction-corpus/assets/scanned-image-only.pdf?inline";

// Parser-only synthetic context, following the existing documents tests. No
// request, database access, inference or authenticated workspace is involved.
const tenant = {
  userId: "synthetic-corpus-parser",
  authority: "job",
} as TenantContext;
afterEach(() => vi.restoreAllMocks());
function bytesFromAsset(asset: string) {
  if (!/^data:[^,]*;base64,/.test(asset))
    throw new Error("Fixture asset must be imported as its exact base64 bytes");
  return Uint8Array.from(atob(asset.slice(asset.indexOf(",") + 1)), (value) =>
    value.charCodeAt(0),
  );
}
async function extract(
  asset: string,
  filename: string,
  mimeType: string,
  hash: string,
) {
  const bytes = bytesFromAsset(asset);
  const actualHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  expect(actualHash).toBe(hash);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("Local synthetic parser must not make provider calls"),
    );
  const result = await createDocumentTextExtractor({
    pdf: createLocalPdfTextExtractor(),
  }).extract(
    {
      connectionId: "synthetic-corpus-mailbox",
      providerMessageId: filename,
      root: {
        partId: "attachment",
        filename,
        mimeType,
        disposition: "attachment",
        bytes,
      },
    },
    { tenant },
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(result.documents).toHaveLength(1);
  return result;
}
function moneyAfter(text: string, label: string) {
  const amount = text.match(
    new RegExp(`${label} EUR ([0-9]+\\.[0-9]{2})`),
  )?.[1];
  if (!amount)
    throw new Error(`Actual parsed numeric line is missing: ${label}`);
  return parseMoney(amount, "EUR");
}
it("T22/DOCUMENT-02 actual corpus two-page PDF preserves final-page cash, gross, subtotal and tax exactly", async () => {
  const result = await extract(
    cleanPdf,
    "clean-two-page.pdf",
    "application/pdf",
    "93c2226f91decb53347441d36c653d1f315a821fb076dba444f8c9f4be6d1354",
  );
  expect(result.status).toBe("ready");
  const document = result.documents[0];
  if (document?.status !== "ready")
    throw new Error("Actual clean corpus PDF did not yield readable text");
  expect(document.pageCount).toBe(2);
  expect(document.textParts).toHaveLength(2);
  const first = document.textParts[0]?.text ?? "",
    last = document.textParts[1]?.text ?? "";
  expect(first).toContain("Corpus Shop");
  expect(moneyAfter(first, "Subtotal")).toBe(10000n);
  expect(moneyAfter(first, "Tax")).toBe(2000n);
  expect(moneyAfter(last, "Total")).toBe(12000n);
  expect(moneyAfter(last, "Paid by card")).toBe(12000n);
});
it.each([
  {
    name: "compressed-text.pdf",
    asset: compressedPdf,
    hash: "f3acd279ba8909669ddce61690dc44f11d30cf9b0effb19b1869260e6bcb9b08",
    code: "compressed_pdf",
  },
  {
    name: "scanned-image-only.pdf",
    asset: scannedPdf,
    hash: "cf92ee0edee4601ac19eea911885e71a973278c5aa530eeec8d1baffb74c381c",
    code: "textless_pdf",
  },
])(
  "T22/DOCUMENT-03 actual $name stays reviewable without invented OCR or numeric extraction",
  async ({ name, asset, hash, code }) => {
    const result = await extract(asset, name, "application/pdf", hash);
    expect(result.status).toBe("needs_review");
    expect(result.documents[0]).toMatchObject({ status: "needs_review", code });
    expect(result.documents[0]).not.toHaveProperty("textParts");
  },
);
it.each([
  {
    name: "probe.jpg",
    mime: "image/jpeg",
    asset: jpeg,
    hash: "0abe34f755c8bebef2832b6c278efd58c4e63751e0dd01b17c1755aba5cf3d64",
  },
  {
    name: "probe.png",
    mime: "image/png",
    asset: png,
    hash: "a93c17028d894827813ce3f52be4c7f70b5e33571bd9e51ca8fd2975ef03a1a9",
  },
])(
  "T22/DOCUMENT-03 valid blank $name truthfully requires a verified image parser",
  async ({ name, mime, asset, hash }) => {
    const result = await extract(asset, name, mime, hash);
    expect(result.status).toBe("needs_review");
    expect(result.documents[0]).toMatchObject({
      status: "needs_review",
      code: "image_requires_verified_parser",
    });
    expect(result.documents[0]).not.toHaveProperty("textParts");
  },
);
