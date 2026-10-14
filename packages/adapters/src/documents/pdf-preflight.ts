import type { DocumentCode, DocumentLimits } from "@invoxim/core";

const activeNames = new Set([
  "javascript",
  "js",
  "openaction",
  "aa",
  "launch",
  "embeddedfile",
  "richmedia",
  "xfa",
  "acroform",
  "gotor",
  "submitform",
  "rendition",
]);
const unsupportedNames = new Set([
  "objstm",
  "xref",
  "xrefstm",
  "prev",
  "decodeparms",
  "dp",
  "f",
  "ffilter",
  "fdecodeparms",
  "lzwdecode",
  "dctdecode",
  "jpxdecode",
  "ascii85decode",
  "asciihexdecode",
  "ccittfaxdecode",
  "runlengthdecode",
  "jbig2decode",
  "crypt",
]);
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_STREAMS = 128;
const MAX_OBJECTS = 4096;
export const LOCAL_PDF_PARSER_VERSION = "unpdf-1.8.1/bounded-flate-v2";

/** Byte-preserving representation: unlike TextDecoder(latin1), never maps PDF bytes. */
function binaryText(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return chunks.join("");
}
function names(source: string): string[] {
  // Literal strings and comments are data, not dictionary names or executable PDF features.
  const result: string[] = [];
  let parentheses = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (parentheses) {
      if (character === "\\") cursor++;
      else if (character === "(") parentheses++;
      else if (character === ")") parentheses--;
      continue;
    }
    if (character === "(") {
      parentheses = 1;
      continue;
    }
    if (character === "%") {
      while (cursor < source.length && !/[\r\n]/.test(source[cursor] ?? ""))
        cursor++;
      continue;
    }
    if (character !== "/") continue;
    if (result.length >= 100000) return ["$complexity-limit"];
    const start = ++cursor;
    while (
      cursor < source.length &&
      !/[\s()<>[\]{}/%]/.test(source[cursor] ?? "")
    )
      cursor++;
    result.push(
      source
        .slice(start, cursor)
        .replace(/#([0-9a-f]{2})/gi, (_whole, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .toLowerCase(),
    );
    cursor--;
  }
  return result;
}
function refusedNames(source: string): DocumentCode | null {
  for (const name of names(source)) {
    if (name === "$complexity-limit") return "part_limit";
    if (name === "encrypt") return "encrypted_pdf";
    if (activeNames.has(name)) return "active_pdf";
    if (unsupportedNames.has(name)) return "compressed_pdf";
    if (name.endsWith("decode") && name !== "flatedecode")
      return "compressed_pdf";
  }
  return null;
}

/** Accept only complete conventional tables; never delegate broken-table recovery to PDF.js. */
function validateClassicXref(
  source: string,
  offset: number,
  streams: readonly { start: number; end: number }[],
  offsets: Map<number, { position: number; generation: number }>,
): DocumentCode | null {
  const lines = source.slice(offset).split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== "xref") return "malformed_pdf";
  const entries = new Set<number>();
  let used = 0;
  let line = 1;
  while (line < lines.length) {
    const header = lines[line]?.trim() ?? "";
    if (header.startsWith("trailer")) break;
    if (!header) {
      line++;
      continue;
    }
    const subsection = /^(\d+)\s+(\d+)$/.exec(header);
    if (!subsection) return "malformed_pdf";
    const first = Number(subsection[1]);
    const count = Number(subsection[2]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      first + count > MAX_OBJECTS + 1
    )
      return "part_limit";
    line++;
    for (let index = 0; index < count; index++, line++) {
      const entry = /^(\d{10}) (\d{5}) ([nf])\s*$/.exec(lines[line] ?? "");
      if (!entry) return "malformed_pdf";
      const id = first + index;
      if (entries.has(id)) return "malformed_pdf";
      entries.add(id);
      if (entries.size > MAX_OBJECTS + 1) return "part_limit";
      if (entry[3] === "f") continue;
      if (id === 0) return "malformed_pdf";
      used++;
      const position = Number(entry[1]);
      offsets.set(id, { position, generation: Number(entry[2]) });
      if (
        position >= offset ||
        streams.some(
          (stream) => position >= stream.start && position < stream.end,
        ) ||
        !new RegExp(`^${id}\\s+${Number(entry[2])}\\s+obj\\b`).test(
          source.slice(position),
        )
      )
        return "malformed_pdf";
    }
  }
  const trailer = lines.slice(line).join("\n");
  if (!/^trailer\s*<</.test(trailer)) return "malformed_pdf";
  const trailerDictionary = trailer.slice(0, trailer.lastIndexOf(">>") + 2);
  if (/[()%#]/.test(trailerDictionary)) return "compressed_pdf";
  const sizes = [...trailerDictionary.matchAll(/\/Size\s+(\d+)(?=\s|\/|>)/g)];
  if (
    sizes.length !== 1 ||
    names(trailer).filter((name) => name === "size").length !== 1 ||
    /\/Size\s+\d+\s+\d+\s+R/.test(trailer) ||
    !used ||
    !entries.has(0) ||
    !/^trailer\s*<<[\s\S]*>>\s*startxref\s+\d+\s+%%EOF\s*$/.test(trailer)
  )
    return "malformed_pdf";
  const size = Number(sizes[0]?.[1]);
  if (!Number.isSafeInteger(size) || size < 2 || size > MAX_OBJECTS + 1)
    return "part_limit";
  if (entries.size !== size || [...entries].some((id) => id >= size))
    return "malformed_pdf";
  return null;
}

function canonicalDictionary(value: string): boolean {
  return (
    !/[()%#]/.test(value) &&
    /^<<[\s\S]*>>\s*$/.test(value) &&
    (value.match(/<<|>>/g)?.length ?? 0) === 2
  );
}
function validateCatalog(
  source: string,
  xrefOffset: number,
  offsets: ReadonlyMap<number, { position: number; generation: number }>,
): DocumentCode | null {
  const trailer = source.slice(xrefOffset);
  const roots = [...trailer.matchAll(/\/Root\s+(\d+)\s+(\d+)\s+R(?=\s|\/|>)/g)];
  if (
    roots.length !== 1 ||
    names(trailer).filter((name) => name === "root").length !== 1
  )
    return "malformed_pdf";
  function dictionary(id: number, generation: number): string | null {
    const entry = offsets.get(id);
    if (!entry || entry.generation !== generation) return null;
    const nextOffset = Math.min(
      xrefOffset,
      ...[...offsets.values()]
        .filter((next) => next.position > entry.position)
        .map((next) => next.position),
    );
    const object = new RegExp(
      `^${id}\\s+${generation}\\s+obj\\s*(<<[\\s\\S]*>>)\\s*endobj\\s*$`,
    ).exec(source.slice(entry.position, nextOffset));
    const value = object?.[1];
    return value && canonicalDictionary(value) ? value : null;
  }
  const catalog = dictionary(Number(roots[0]?.[1]), Number(roots[0]?.[2]));
  if (!catalog || !/\/Type\s*\/Catalog(?=\s|\/|>)/.test(catalog))
    return "malformed_pdf";
  const pageReferences = [
    ...catalog.matchAll(/\/Pages\s+(\d+)\s+(\d+)\s+R(?=\s|\/|>)/g),
  ];
  if (
    pageReferences.length !== 1 ||
    names(catalog).filter((name) => name === "pages").length !== 1
  )
    return "malformed_pdf";
  const pages = dictionary(
    Number(pageReferences[0]?.[1]),
    Number(pageReferences[0]?.[2]),
  );
  if (!pages || !/\/Type\s*\/Pages(?=\s|\/|>)/.test(pages))
    return "malformed_pdf";
  const count = /\/Count\s+(\d+)(?=\s|\/|>)/.exec(pages);
  if (
    !count ||
    names(pages).filter((name) => name === "count").length !== 1 ||
    /\/Count\s+\d+\s+\d+\s+R/.test(pages)
  )
    return "malformed_pdf";
  if (Number(count[1]) < 1 || Number(count[1]) > MAX_OBJECTS)
    return "page_limit";
  return null;
}

/** Conservative support gate, not a replacement PDF parser. Unsupported layouts fail closed. */
export async function preflightPdf(
  bytes: Uint8Array,
  limits: Readonly<DocumentLimits>,
  signal?: AbortSignal,
): Promise<DocumentCode | null> {
  if (bytes.length > limits.bytes) return "byte_limit";
  const source = binaryText(bytes);
  if (!source.startsWith("%PDF-") || !source.trimEnd().endsWith("%%EOF"))
    return "malformed_pdf";
  const xref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(source);
  const offsets = new Map<number, { position: number; generation: number }>();
  const invalidTable = xref
    ? validateClassicXref(source, Number(xref[1]), [], offsets)
    : "malformed_pdf";
  if (invalidTable) {
    const refused = refusedNames(source);
    if (refused) return refused;
    if (names(source).includes("filter") && !source.includes("stream"))
      return "compressed_pdf";
    return invalidTable;
  }
  const invalidCatalog = validateCatalog(source, Number(xref?.[1]), offsets);
  if (invalidCatalog) return invalidCatalog;
  const deadline = Date.now() + 10000;
  const streamRanges: { start: number; end: number }[] = [];
  let offset = 0;
  let inflated = 0;
  let streamCount = 0;
  const sections: string[] = [];
  // Only conventional streams with explicit direct or integer-object lengths are accepted. This avoids
  // trusting delimiter-like bytes inside compression data or object streams.
  const streams = /\bstream\r?\n/g;
  while (true) {
    const match = streams.exec(source);
    if (!match) break;
    if (signal?.aborted) return "canceled";
    if (++streamCount > MAX_STREAMS) return "part_limit";
    const header = source.slice(offset, match.index);
    const refused = refusedNames(header);
    if (refused) return refused;
    sections.push(header);
    const dictionaryStart = header.lastIndexOf("<<");
    const dictionary = header.slice(dictionaryStart);
    // Stream control dictionaries use a deliberately narrow grammar. Comments, literal
    // strings and escaped names are refused rather than guessing whether raw text is a key.
    if (!canonicalDictionary(dictionary)) return "compressed_pdf";
    const lengthMatch = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?(?=\s|>|\/)/.exec(
      dictionary,
    );
    if (dictionaryStart < 0 || !lengthMatch) return "compressed_pdf";
    if (names(dictionary).filter((name) => name === "length").length !== 1)
      return "malformed_pdf";
    let length = Number(lengthMatch[1]);
    if (lengthMatch[2] !== undefined) {
      const scalarOffset = offsets.get(Number(lengthMatch[1]));
      if (!scalarOffset || scalarOffset.generation !== Number(lengthMatch[2]))
        return "malformed_pdf";
      const scalar = new RegExp(
        `^${lengthMatch[1]} ${lengthMatch[2]} obj\\s+(\\d+)\\s+endobj\\b`,
      ).exec(source.slice(scalarOffset.position));
      if (!scalar) return "malformed_pdf";
      length = Number(scalar[1]);
    }
    const start = streams.lastIndex;
    const end = start + length;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      end > bytes.length ||
      !/^(?:\r?\n)?endstream\b/.test(source.slice(end, end + 16))
    )
      return "malformed_pdf";
    const filterNames = names(dictionary).filter((name) => name === "filter");
    const hasFilter = filterNames.length > 0;
    if (
      hasFilter &&
      (filterNames.length !== 1 ||
        !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])(?=\s|>|\/)/.test(
          dictionary,
        ))
    )
      return "compressed_pdf";
    if (/\b\d+\s+\d+\s+obj\b/.test(source.slice(start, end)))
      return "compressed_pdf";
    streamRanges.push({ start, end });
    if (hasFilter) {
      let compressedOffset = start;
      // workerd buffers each complete input chunk's inflated output before exposing it.
      // Feed 1KiB at a time, rather than Blob's large chunks: DEFLATE's maximum
      // 1032:1 expansion then bounds that native burst to approximately 1MiB.
      const compressedInput = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (compressedOffset >= end) {
              controller.close();
              return;
            }
            const next = Math.min(end, compressedOffset + 1024);
            controller.enqueue(bytes.subarray(compressedOffset, next));
            compressedOffset = next;
          },
        },
        { highWaterMark: 0 },
      );
      const reader = compressedInput
        .pipeThrough(new DecompressionStream("deflate"))
        .getReader();
      let streamBytes = 0;
      const chunks: Uint8Array[] = [];
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (signal?.aborted) return "canceled";
          if (Date.now() > deadline) return "converter_unavailable";
          const chunk = await reader.read();
          if (signal?.aborted) return "canceled";
          if (Date.now() > deadline) return "converter_unavailable";
          if (chunk.done) break;
          streamBytes += chunk.value.byteLength;
          inflated += chunk.value.byteLength;
          if (
            inflated > MAX_INFLATED_BYTES ||
            streamBytes > Math.max(65536, length * 100)
          )
            return "compressed_pdf";
          chunks.push(chunk.value);
        }
        const decoded = new Uint8Array(streamBytes);
        let position = 0;
        for (const chunk of chunks) {
          decoded.set(chunk, position);
          position += chunk.byteLength;
        }
        const content = binaryText(decoded);
        if (/\bBI\s/.test(content)) return "compressed_pdf";
        const refusedContent = refusedNames(content);
        if (refusedContent) return refusedContent;
      } catch {
        return signal?.aborted ? "canceled" : "malformed_pdf";
      } finally {
        signal?.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
      }
    } else {
      inflated += length;
      if (inflated > MAX_INFLATED_BYTES) return "compressed_pdf";
      if (/\bBI\s/.test(source.slice(start, end))) return "compressed_pdf";
      const refusedContent = refusedNames(source.slice(start, end));
      if (refusedContent) return refusedContent;
    }
    offset = end;
    streams.lastIndex = end;
  }
  const tail = source.slice(offset);
  const refused = refusedNames(tail);
  if (refused) return refused;
  // A filter outside a supported stream must never reach PDF.js unchecked.
  if (!streamCount && names(source).includes("filter")) return "compressed_pdf";
  sections.push(tail);
  // Any spelling outside the checked canonical ranges is unsupported. PDF.js also
  // accepts bare CR/space variations; none may bypass the bounded inflation pass.
  if (sections.some((section) => /\bstream\b/.test(section)))
    return "compressed_pdf";
  // Refuse xref pointers into opaque stream data: PDF.js must never discover a hidden
  // object/filter that was excluded from the bounded stream pass above.
  for (const { position } of offsets.values()) {
    if (
      streamRanges.some(
        (range) => position >= range.start && position < range.end,
      )
    )
      return "malformed_pdf";
  }
  let objects = 0;
  for (const section of sections) {
    const objectMatches = section.matchAll(/\b\d+\s+\d+\s+obj\b/g);
    while (!objectMatches.next().done) {
      if (++objects > MAX_OBJECTS) return "part_limit";
    }
  }
  let depth = 0;
  for (const section of sections) {
    for (const token of section.matchAll(/<<|>>|\[|\]/g)) {
      depth += token[0] === "<<" || token[0] === "[" ? 1 : -1;
      if (depth > limits.depth) return "depth_limit";
      depth = Math.max(0, depth);
    }
  }
  return null;
}
