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

function encodeObjects(
  objects: readonly (string | Uint8Array)[],
  trailerExtras = "",
  rootId = 1,
): Uint8Array {
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
        )}\ntrailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R ${trailerExtras} >>\nstartxref\n${length}\n%%EOF\n`,
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

/** Passive URI annotations are common on invoice PDFs; text extraction never follows them. */
export function generateLinkedInvoicePdf(
  action = "/URI (https://synthetic.invalid/invoice)",
): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td (Invoice total EUR 123.45) Tj ET";
  return encodeObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Annot /Subtype /Link /Rect [70 700 300 730] /A << /S /URI ${action} >> >>`,
  ]);
}

/** Synthetic hybrid/incremental trailer declaration; no network or customer data. */
export function generateSecondaryXrefPdf(
  feature: "/Prev" | "/XRefStm" | "/P#72ev" | "/XRef#53tm",
): Uint8Array {
  return encodeObjects(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ],
    `${feature} 0`,
  );
}

export function generateObjectHeavyPdf(): Uint8Array {
  return encodeObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ...Array.from({ length: 4094 }, () => "<<>>"),
  ]);
}

export function generateLengthDecoyPdf(indirect: boolean): Uint8Array {
  // Both offsets contain endstream: raw-regex length selection could validate the
  // decoy prefix rather than the actual stream. Neither fixture is customer data.
  const payload = `${"X".repeat(20)}endstream\n${"Y".repeat(70)}`;
  const objects: (string | Uint8Array)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< ${indirect ? "/Length 6 0 R" : `/Decoy (/Length 20) /Length ${payload.length}`} >>\nstream\n${payload}\nendstream`,
  ];
  if (indirect) {
    const text = new TextEncoder().encode("\n6 0 obj\n20\nendobj\n");
    // One uncompressed DEFLATE block inside a valid zlib stream, retaining literal decoy bytes.
    let a = 1;
    let b = 0;
    for (const byte of text) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    const deflated = Uint8Array.from([
      0x78,
      0x01,
      0x01,
      text.length,
      0,
      255 - text.length,
      255,
      ...text,
      b >>> 8,
      b & 255,
      a >>> 8,
      a & 255,
    ]);
    const prefix = new TextEncoder().encode(
      `<< /Filter /FlateDecode /Length ${deflated.length} >>\nstream\n`,
    );
    const suffix = new TextEncoder().encode("\nendstream");
    const carrier = new Uint8Array(
      prefix.length + deflated.length + suffix.length,
    );
    carrier.set(prefix);
    carrier.set(deflated, prefix.length);
    carrier.set(suffix, prefix.length + deflated.length);
    objects.push(
      carrier,
      `% Actual xref-authorized scalar has unsupported comment syntax\n${payload.length}`,
    );
  }
  return encodeObjects(objects);
}

export function generatePdfGateRegression(
  kind: "nested-length" | "invalid-root" | "invalid-pages" | "unclaimed-stream",
): Uint8Array {
  const payload = `${"X".repeat(20)}endstream\n${"Y".repeat(70)}`;
  return encodeObjects(
    [
      `<< /Type /Catalog /Pages ${kind === "invalid-pages" ? 9999 : 2} 0 R >>`,
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      kind === "nested-length"
        ? `<< /Length ${payload.length} /Extra << /Length 20 >> >>\nstream\n${payload}\nendstream`
        : `<< /Length ${payload.length} >>\nstream\n${payload}\nendstream`,
      ...(kind === "unclaimed-stream"
        ? ["<< /Length 3 /Filter /FlateDecode >>\nstream\rABC\rendstream"]
        : []),
    ],
    "",
    kind === "invalid-root" ? 9999 : 1,
  );
}
