import { inertHtmlText } from "./html";

interface Range {
  start: number;
  end: number;
}
/** Exact source slices only: omissions never join unrelated evidence into one quote. */
export function selectBodyText(
  text: string,
  html: boolean,
  maximum: number,
): {
  spans: { text: string; start: number; end: number }[];
  truncated: boolean;
  complete: boolean;
} {
  const ranges: Range[] = [];
  let overflow = false;
  const add = (start: number, end: number) => {
    if (!text.slice(start, end).trim()) return;
    const last = ranges[ranges.length - 1];
    if (last && start === last.end) {
      last.end = end;
      return;
    }
    // Bound selector metadata independently of source bytes. Keep the final source
    // range even if an adversarial body exceeds this structural budget.
    if (ranges.length >= 4096) {
      overflow = true;
      ranges[ranges.length - 1] = { start, end };
      return;
    }
    ranges.push({ start, end });
  };
  if (html) {
    const result = inertHtmlText(text, add);
    if (!result.complete)
      return { spans: [], truncated: false, complete: false };
  } else {
    let start = 0;
    for (const line of text.split(/(?<=\n)/)) {
      if (!/^\s*>/.test(line)) add(start, start + line.length);
      else overflow = true;
      start += line.length;
    }
  }
  const total = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  let selected = ranges;
  if (total > maximum) {
    overflow = true;
    // Stable head/tail plus a central evidence window. Keyword matching selects
    // source text only; it never interprets amounts, payment status or acceptance.
    const head = Math.floor(maximum / 4);
    const tail = Math.floor(maximum / 4);
    let headRemaining = head;
    const chosen: Range[] = [];
    for (const range of ranges) {
      const size = Math.min(headRemaining, range.end - range.start);
      if (size > 0)
        chosen.push({ start: range.start, end: range.start + size });
      headRemaining -= size;
    }
    let tailRemaining = tail;
    for (const range of [...ranges].reverse()) {
      const size = Math.min(tailRemaining, range.end - range.start);
      if (size > 0) chosen.push({ start: range.end - size, end: range.end });
      tailRemaining -= size;
    }
    let remaining = maximum - head - tail;
    const evidence =
      /invoice|receipt|rechnung|factur|total|gesamt|amount|paid|refund|[€£¥]|\b(?:EUR|USD|GBP)\b/gi;
    for (const range of ranges) {
      evidence.lastIndex = range.start;
      const match = evidence.exec(text);
      if (!match || match.index >= range.end) continue;
      const start = Math.max(range.start, match.index - 256);
      const end = Math.min(range.end, start + remaining);
      if (end > start) chosen.push({ start, end });
      remaining -= end - start;
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      for (const range of ranges) {
        const size = Math.min(remaining, range.end - range.start);
        if (size > 0)
          chosen.push({ start: range.start, end: range.start + size });
        remaining -= size;
      }
    }
    selected = chosen
      .sort((a, b) => a.start - b.start)
      .reduce<Range[]>((all, range) => {
        const last = all[all.length - 1];
        if (last && range.start <= last.end)
          last.end = Math.max(last.end, range.end);
        else all.push({ ...range });
        return all;
      }, []);
  }
  // The model protocol accepts 64 independently cited parts. Select across the
  // complete bounded range set before applying this limit, preserving the tail.
  if (selected.length > 64) {
    selected = [...selected.slice(0, 32), ...selected.slice(-32)];
    overflow = true;
  }
  return {
    complete: true,
    truncated: overflow,
    spans: selected
      .map((range) => {
        let { start, end } = range;
        // Avoid producing lone UTF-16 surrogates at an excerpt boundary.
        if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? ""))
          end--;
        return { start, end, text: text.slice(start, end) };
      })
      .filter((span) => span.text.length > 0),
  };
}
