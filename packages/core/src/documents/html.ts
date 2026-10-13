const hiddenElements = new Set([
  "script",
  "style",
  "head",
  "template",
  "iframe",
  "object",
  "svg",
  "math",
  "form",
  "button",
  "select",
  "textarea",
  "canvas",
]);
const blockElements = new Set([
  "p",
  "div",
  "br",
  "tr",
  "table",
  "li",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "hr",
]);
const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  pound: "£",
  yen: "¥",
};
function entityText(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (whole, value: string) => {
      if (!value.startsWith("#")) return entities[value.toLowerCase()] ?? whole;
      const hexadecimal = value[1]?.toLowerCase() === "x";
      const point = Number.parseInt(
        value.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10,
      );
      if (
        !Number.isSafeInteger(point) ||
        point < 1 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        return whole;
      return String.fromCodePoint(point);
    },
  );
}
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let cursor = start; cursor < html.length; cursor++) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor;
  }
  return -1;
}
/** Tokenizes text only. There is no DOM, rendering, URL resolution, or outbound port. */
export function inertHtmlText(html: string): {
  text: string;
  complete: boolean;
} {
  const lower = html.toLowerCase();
  const chunks: string[] = [];
  let cursor = 0;
  const hiddenStack: string[] = [];
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) {
      if (hiddenStack.length === 0) chunks.push(html.slice(cursor));
      break;
    }
    if (hiddenStack.length === 0) chunks.push(html.slice(cursor, opening));
    if (lower.startsWith("<!--", opening)) {
      const end = lower.indexOf("-->", opening + 4);
      if (end < 0) return { text: "", complete: false };
      cursor = end + 3;
      continue;
    }
    const end = tagEnd(html, opening + 1);
    if (end < 0) return { text: "", complete: false };
    const token = html.slice(opening + 1, end).trim();
    const name = /^\/?([a-z][a-z0-9:-]*)/i.exec(token)?.[1]?.toLowerCase();
    if ((name === "script" || name === "style") && !token.startsWith("/")) {
      let close = lower.indexOf(`</${name}`, end + 1);
      while (close >= 0) {
        const boundary = lower[close + name.length + 2];
        if (
          boundary === ">" ||
          boundary === "/" ||
          (boundary !== undefined && /\s/.test(boundary))
        )
          break;
        close = lower.indexOf(`</${name}`, close + name.length + 2);
      }
      if (close < 0) return { text: "", complete: false };
      const closeEnd = tagEnd(html, close + 1);
      if (closeEnd < 0) return { text: "", complete: false };
      cursor = closeEnd + 1;
      continue;
    }
    if (name && token.startsWith("/")) {
      const index = hiddenStack.lastIndexOf(name);
      if (index >= 0) hiddenStack.length = index;
    } else if (name && hiddenElements.has(name)) {
      if (hiddenStack.length >= 64) return { text: "", complete: false };
      hiddenStack.push(name);
    }
    if (hiddenStack.length > 0) {
      cursor = end + 1;
      continue;
    }
    if (name && blockElements.has(name)) chunks.push("\n");
    else if (name === "td" || name === "th") chunks.push(" ");
    cursor = end + 1;
  }
  if (hiddenStack.length > 0) return { text: "", complete: false };
  const text = entityText(chunks.join(""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { text, complete: true };
}
