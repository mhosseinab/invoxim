/** Gmail's discovery document specifies rootUrl + batchPath, not a user URL. */
export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch";
export interface AttachmentReference {
  id: string;
  size: number;
  partKey: string;
}
export interface AttachmentBatchResult {
  status: number;
  retryAfterMs?: number;
  value?: unknown;
}
export function attachmentBatchRequest(
  messageId: string,
  refs: AttachmentReference[],
) {
  const boundary = `invoxim_${crypto.randomUUID()}`;
  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: `${refs
      .map(
        (ref, index) =>
          `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <attachment-${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(ref.id)} HTTP/1.1\r\nAccept: application/json\r\n\r\n`,
      )
      .join("")}--${boundary}--\r\n`,
  };
}
function headers(text: string): Map<string, string> {
  if (text.length > 8192) throw new Error("INVALID_GMAIL_BATCH");
  const result = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined)
      throw new Error("INVALID_GMAIL_BATCH");
    const name = match[1].toLowerCase();
    if (result.has(name)) throw new Error("INVALID_GMAIL_BATCH");
    result.set(name, match[2].trim());
  }
  return result;
}
function requireUnencoded(headers: ReadonlyMap<string, string>, mime = false) {
  for (const name of [
    "content-encoding",
    "transfer-encoding",
    "content-transfer-encoding",
  ]) {
    const encoding = headers.get(name)?.toLowerCase();
    if (
      encoding !== undefined &&
      encoding !== "identity" &&
      !(mime && name === "content-transfer-encoding" && encoding === "binary")
    )
      throw new Error("INVALID_GMAIL_BATCH");
  }
}
export function retryAfterMs(
  value: string | null | undefined,
): number | undefined {
  if (!value) return;
  if (value.length > 128) return 86400001;
  const numeric = /^\d+$/.test(value);
  if (
    !numeric &&
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
  )
    return;
  const milliseconds = numeric
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  if (!numeric && !Number.isFinite(milliseconds)) return;
  return Number.isSafeInteger(milliseconds) && milliseconds <= 86400000
    ? Math.max(1000, milliseconds)
    : 86400001;
}
/** Input is already bounded by the shared source stream byte/chunk/deadline limit. */
export function parseAttachmentBatch(
  text: string,
  contentType: string,
  expectedCount: number,
): AttachmentBatchResult[] {
  const match =
    /^multipart\/mixed\s*;\s*boundary=(?:"([A-Za-z0-9_-]{1,70})"|([A-Za-z0-9_-]{1,70}))\s*$/i.exec(
      contentType,
    );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || expectedCount < 2 || expectedCount > 8)
    throw new Error("INVALID_GMAIL_BATCH");
  const marker = `--${boundary}`;
  if (!text.startsWith(`${marker}\r\n`)) throw new Error("INVALID_GMAIL_BATCH");
  // At most the expected parts, closing delimiter and one overflow sentinel.
  const sections = text.split(`\r\n${marker}`, expectedCount + 2);
  const closing = sections.pop();
  if (closing !== "--\r\n" && closing !== "--")
    throw new Error("INVALID_GMAIL_BATCH");
  if (sections.length !== expectedCount) throw new Error("INVALID_GMAIL_BATCH");
  const results = new Map<number, AttachmentBatchResult>();
  for (const [position, section] of sections.entries()) {
    if (position > 0 && !section.startsWith("\r\n"))
      throw new Error("INVALID_GMAIL_BATCH");
    const part =
      position === 0 ? section.slice(marker.length + 2) : section.slice(2);
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) throw new Error("INVALID_GMAIL_BATCH");
    const metadata = headers(part.slice(0, separator));
    requireUnencoded(metadata, true);
    if (metadata.get("content-type")?.toLowerCase() !== "application/http")
      throw new Error("INVALID_GMAIL_BATCH");
    const identity = /^<response-attachment-(\d)>$/.exec(
      metadata.get("content-id") ?? "",
    );
    const index = Number(identity?.[1]);
    if (!identity || index >= expectedCount || results.has(index))
      throw new Error("INVALID_GMAIL_BATCH");
    const response = part.slice(separator + 4);
    const statusEnd = response.indexOf("\r\n");
    const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(
      response.slice(0, statusEnd),
    );
    const headerEnd = response.indexOf("\r\n\r\n", statusEnd);
    if (!status || statusEnd < 0 || headerEnd < 0)
      throw new Error("INVALID_GMAIL_BATCH");
    const innerHeaders = headers(response.slice(statusEnd + 2, headerEnd));
    requireUnencoded(innerHeaders);
    const code = Number(status[1]);
    const retry =
      retryAfterMs(innerHeaders.get("retry-after")) ??
      (code === 429 ? 30000 : undefined);
    const body = response.slice(headerEnd + 4);
    if (
      code === 200 &&
      !/^application\/json(?:\s*;.*)?$/i.test(
        innerHeaders.get("content-type") ?? "",
      )
    )
      throw new Error("INVALID_GMAIL_BATCH");
    results.set(index, {
      status: code,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
      ...(code === 200 ? { value: JSON.parse(body) as unknown } : {}),
    });
  }
  return Array.from({ length: expectedCount }, (_, index) => {
    const result = results.get(index);
    if (!result) throw new Error("INVALID_GMAIL_BATCH");
    return result;
  });
}
