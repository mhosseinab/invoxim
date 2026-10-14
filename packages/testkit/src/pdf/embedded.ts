import { bytesFromInlineAsset } from "../fetch-spy";
// Synthetic invoice generated with Ghostscript pdfwrite, PDF 1.4, EmbedAllFonts,
// SubsetFonts and CompressFonts enabled. Local test data; no customer content.
// Uses an embedded compressed Type1 font and an indirect stream length.
import embeddedInvoiceAsset from "./assets/embedded-invoice.pdf?inline";

export function embeddedInvoicePdf(): Uint8Array {
  return bytesFromInlineAsset(embeddedInvoiceAsset);
}
