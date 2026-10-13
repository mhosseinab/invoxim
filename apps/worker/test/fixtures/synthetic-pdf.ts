// Synthetic uncompressed PDFs only. No customer documents or receipt bytes.
export function generateTextPdf(
  pages: readonly (readonly string[])[],
): Uint8Array {
  const objects: string[] = [];
  const fontId = 3 + pages.length * 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (const [index, lines] of pages.entries()) {
    const pageId = 3 + index * 2;
    const stream = [
      "BT /F1 12 Tf 72 720 Td 16 TL",
      ...lines.flatMap((line, lineIndex) => {
        if (!/^[\x20-\x7e]*$/.test(line))
          throw new Error("SYNTHETIC_PDF_ASCII_ONLY");
        const escaped = line.replace(
          /[\\()]/g,
          (character) => `\\${character}`,
        );
        return [lineIndex === 0 ? `(${escaped}) Tj` : `T* (${escaped}) Tj`];
      }),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return encodeObjects(objects);
}

function encodeObjects(objects: readonly (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  let length = chunks[0]?.length ?? 0;
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const header = encoder.encode(`${index + 1} 0 obj\n`);
    const body = typeof object === "string" ? encoder.encode(object) : object;
    const ending = encoder.encode("\nendobj\n");
    chunks.push(header, body, ending);
    length += header.length + body.length + ending.length;
  }
  chunks.push(
    encoder.encode(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
        .join(
          "\n",
        )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

export function generateImageOnlyPdf(): Uint8Array {
  const stream = "q 100 0 0 100 72 620 cm /Im1 Do Q";
  return encodeObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nAAA\nendstream",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]);
}

export async function generateCompressedTextPdf(
  text: string,
): Promise<Uint8Array> {
  if (text.length > 2 * 1024 * 1024 || !/^[\x20-\x7e]*$/.test(text))
    throw new Error("SYNTHETIC_PDF_TEXT_BOUND");
  const encoder = new TextEncoder();
  const stream = encoder.encode(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([stream]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const prefix = encoder.encode(
    `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const suffix = encoder.encode("\nendstream");
  const object = new Uint8Array(
    prefix.length + compressed.length + suffix.length,
  );
  object.set(prefix);
  object.set(compressed, prefix.length);
  object.set(suffix, prefix.length + compressed.length);
  return encodeObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    object,
  ]);
}
