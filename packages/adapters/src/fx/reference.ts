import {
  type FxRateQuote,
  fxRateQuoteSchema,
  fxRateRequestSchema,
  minorDigits,
} from "@invoxim/contracts";
import type { PublicReferenceRateReader } from "@invoxim/core";
import {
  type FxReferenceConfiguration,
  FxReferenceError,
  fxReferenceConfigurationSchema,
} from "./configuration";

export type FxReferenceTransport = (request: Request) => Promise<Response>;
const maximumBytes = 16384;

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new FxReferenceError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^[0-9]+$/.test(length) || Number(length) > maximumBytes)
  )
    throw new FxReferenceError("invalid_response");
  const reader = response.body?.getReader();
  if (!reader) throw new FxReferenceError("invalid_response");
  const bytes = new Uint8Array(maximumBytes);
  let size = 0;
  let nonemptyReads = 0;
  let emptyReads = 0;
  const checkDeadline = () => {
    if (signal.aborted || Date.now() >= deadline)
      throw new FxReferenceError("timeout");
  };
  try {
    while (true) {
      checkDeadline();
      const item = await abortable(reader.read(), signal);
      checkDeadline();
      if (item.done) break;
      if (item.value.byteLength === 0) {
        if (++emptyReads > 32) throw new FxReferenceError("invalid_response");
        continue;
      }
      if (++nonemptyReads > 4096 || size + item.value.byteLength > maximumBytes)
        throw new FxReferenceError("invalid_response");
      bytes.set(item.value, size);
      size += item.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Closed flat-row grammar keeps JSON rate lexemes exact, including beyond Number precision. */
function rows(body: string): Record<string, string>[] {
  const text = body.trim();
  if (!text.startsWith("[") || !text.endsWith("]"))
    throw new FxReferenceError("invalid_response");
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const objects = [...inner.matchAll(/\{[^{}]*\}/g)];
  if (objects.length === 0 || objects.length > 32)
    throw new FxReferenceError("invalid_response");
  let position = 0;
  const result: Record<string, string>[] = [];
  for (const [index, object] of objects.entries()) {
    if (inner.slice(position, object.index).trim() !== (index === 0 ? "" : ","))
      throw new FxReferenceError("invalid_response");
    position = object.index + object[0].length;
    const record: Record<string, string> = {};
    const fields = object[0].slice(1, -1).split(",");
    if (fields.length !== 4) throw new FxReferenceError("invalid_response");
    for (const field of fields) {
      const match =
        /^\s*"(date|base|quote|rate)"\s*:\s*("[^"\\]*"|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)\s*$/.exec(
          field,
        );
      const key = match?.[1];
      const token = match?.[2];
      if (!key || !token || Object.hasOwn(record, key))
        throw new FxReferenceError("invalid_response");
      if (key === "rate") {
        if (token.startsWith('"'))
          throw new FxReferenceError("invalid_response");
        record[key] = token;
      } else {
        if (!token.startsWith('"'))
          throw new FxReferenceError("invalid_response");
        record[key] = JSON.parse(token) as string;
      }
    }
    result.push(record);
  }
  if (inner.slice(position).trim() !== "")
    throw new FxReferenceError("invalid_response");
  return result;
}

export function createPublicReferenceRateReader(
  input: FxReferenceConfiguration,
  transport: FxReferenceTransport = (request) => fetch(request),
  clock: () => number = Date.now,
): PublicReferenceRateReader {
  const parsed = fxReferenceConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new FxReferenceError("invalid_configuration");
  const config = parsed.data;
  return {
    async lookup(inputRequest) {
      const parsedRequest = fxRateRequestSchema.safeParse(inputRequest);
      if (!parsedRequest.success) throw new FxReferenceError("invalid_request");
      const request = parsedRequest.data;
      try {
        minorDigits(request.fromCurrency);
        minorDigits(request.toCurrency);
      } catch {
        return null;
      }
      if (request.fromCurrency === request.toCurrency) return null;
      const requestedTime = Date.parse(
        `${request.requestedDate}T00:00:00.000Z`,
      );
      const earliestTime = Math.max(
        Date.parse("0001-01-01T00:00:00.000Z"),
        requestedTime - config.maxPriorAgeDays * 86400000,
      );
      const earliestDate = new Date(earliestTime).toISOString().slice(0, 10);
      const url = new URL(
        `https://api.frankfurter.dev/v2/providers/${config.source}/rates`,
      );
      url.searchParams.set("base", request.fromCurrency);
      url.searchParams.set("quotes", request.toCurrency);
      url.searchParams.set("from", earliestDate);
      url.searchParams.set("to", request.requestedDate);
      const controller = new AbortController();
      const deadline = Date.now() + config.timeoutMs;
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const received: { response?: Response } = {};
      try {
        const pending = transport(
          new Request(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            redirect: "manual",
            signal: controller.signal,
          }),
        ).then((response) => {
          if (controller.signal.aborted) cancelBody(response);
          else received.response = response;
          return response;
        });
        const response = await abortable(pending, controller.signal);
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        )
          throw new FxReferenceError("invalid_response");
        if (response.status === 404 || response.status === 422) return null;
        if (response.status !== 200) throw new FxReferenceError("unavailable");
        if (
          response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        )
          throw new FxReferenceError("invalid_response");
        const body = await readBody(response, controller.signal, deadline);
        const retrievedAt = clock();
        const quotes: FxRateQuote[] = [];
        const dates = new Set<string>();
        for (const row of rows(body)) {
          const candidate = fxRateQuoteSchema.safeParse({
            ...request,
            effectiveDate: row.date,
            rate: row.rate,
            source: config.source,
            version: `frankfurter-v2:${config.source}:${row.base}:${row.quote}:${row.date}:${row.rate}`,
            retrievedAt,
          });
          if (
            !candidate.success ||
            row.base !== request.fromCurrency ||
            row.quote !== request.toCurrency ||
            candidate.data.effectiveDate > request.requestedDate ||
            dates.has(candidate.data.effectiveDate)
          )
            throw new FxReferenceError("invalid_response");
          dates.add(candidate.data.effectiveDate);
          if (candidate.data.effectiveDate >= earliestDate)
            quotes.push(candidate.data);
        }
        return (
          quotes.sort((left, right) =>
            right.effectiveDate.localeCompare(left.effectiveDate),
          )[0] ?? null
        );
      } catch (error) {
        if (error instanceof FxReferenceError) throw error;
        throw new FxReferenceError(
          controller.signal.aborted ? "timeout" : "unavailable",
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (received.response) cancelBody(received.response);
      }
    },
  };
}
