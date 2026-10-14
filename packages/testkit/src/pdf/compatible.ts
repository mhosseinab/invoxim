import { generateTextPdf } from "./synthetic";
/** Synthetic conventional xref PDF with common nested catalog preferences. */
export function nestedCatalogPdf(
  preferences = "/DisplayDocTitle true",
  spoof?: "pages" | "count" | "pages-array" | "count-array",
): Uint8Array {
  const original = new TextDecoder().decode(
    generateTextPdf([["Invoice EUR 123.45"]]),
  );
  let body = original
    .slice(0, original.indexOf("xref\n"))
    .replace(
      "/Type /Catalog",
      `/Type /Catalog /ViewerPreferences << ${preferences} >>`,
    );
  if (spoof === "pages")
    body = body.replace("/Pages 2 0 R", "/Extra << /Pages 2 0 R >>");
  if (spoof === "count")
    body = body.replace("/Count 1", "/Extra << /Count 1 >>");
  if (spoof === "pages-array")
    body = body.replace("/Pages 2 0 R", "/Pages [999 0 R] 2 0 R");
  if (spoof === "count-array") body = body.replace("/Count 1", "/Count [99] 1");
  const offsets = [...body.matchAll(/^(\d+) 0 obj$/gm)].map(
    (match) => match.index,
  );
  return new TextEncoder().encode(
    `${body}xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`,
  );
}
