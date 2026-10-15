import { expect, it } from "vitest";
import {
  BoundedJsonError,
  boundedJsonResponse,
  MAX_JSON_RESPONSE_BYTES,
  parseRetryAfter,
  readBoundedJson,
  readJsonRequestBody,
  readJsonResponseBody,
} from "../../../packages/adapters/src/http";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function stream(
  chunks: readonly Uint8Array[],
  onPull?: (pulls: number) => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(++pulls);
      if (index < chunks.length) {
        const chunk = chunks[index++];
        if (!chunk) throw new Error("Synthetic stream chunk unavailable");
        controller.enqueue(chunk);
      } else controller.close();
    },
  });
}

function jsonStream(text: string, emptyChunks = 0, byteChunks = 1) {
  const body = bytes(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < emptyChunks; i++) chunks.push(new Uint8Array());
  const slice = Math.ceil(body.length / byteChunks);
  for (let offset = 0; offset < body.length; offset += slice)
    chunks.push(body.slice(offset, offset + slice));
  return stream(chunks);
}

// --- 3xx pin (D8 / mailbox+discovery response readers) -----------------
// Redirects are refused before a successful body parse: callers fetch with
// redirect:"manual" and treat 300-399 as unavailable.
it.each([300, 301, 302, 303, 307, 308, 399])(
  "response status %i is refused as a redirect before the body is parsed",
  async (status) => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readJsonResponseBody(response, 1024)).rejects.toMatchObject({
      reason: "redirect",
    });
  },
);

it("2xx response bodies still parse", async () => {
  const response = Response.json({ ok: true });
  await expect(readJsonResponseBody(response, 1024)).resolves.toEqual({
    ok: true,
  });
});

// --- content-length pin (auth/http, ai/http, mailbox/*) ----------------
// A declared content-length above the cap rejects early. A missing or
// malformed header falls through to the streamed byte cap (Number(null) is
// 0 and Number("garbage") is NaN, neither of which is > cap).
it("declared content-length above the cap rejects without streaming the body", async () => {
  let pulled = 0;
  const response = new Response(
    stream([bytes('{"ok":true}')], () => pulled++),
    {
      headers: { "content-length": "999999" },
    },
  );
  // Response construction may pull once; the reader must not consume more.
  const pullsAfterConstruct = pulled;
  await expect(readJsonResponseBody(response, 1024)).rejects.toMatchObject({
    reason: "content-length",
  });
  expect(pulled).toBe(pullsAfterConstruct);
});

it("missing content-length falls through to the streamed cap and parses", async () => {
  const response = new Response(jsonStream('{"ok":true}'));
  await expect(readJsonResponseBody(response, 1024)).resolves.toEqual({
    ok: true,
  });
});

it.each(["not-a-number", "12abc", "-1", ""])(
  "malformed content-length %j falls through to the streamed cap",
  async (header) => {
    const response = new Response(jsonStream('{"ok":true}'), {
      headers: { "content-length": header },
    });
    await expect(readJsonResponseBody(response, 1024)).resolves.toEqual({
      ok: true,
    });
  },
);

it("request content-length above the cap rejects before streaming", async () => {
  let pulled = 0;
  const request = new Request("https://synthetic.example.test/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "content-length": "5000",
    },
    body: stream([bytes('{"ok":true}')], () => pulled++),
  });
  // Request construction may pull once; the reader must not consume more.
  const pullsAfterConstruct = pulled;
  await expect(readJsonRequestBody(request, 1024)).rejects.toMatchObject({
    reason: "content-length",
  });
  expect(pulled).toBe(pullsAfterConstruct);
});

// --- request content-type pin (auth/http) ------------------------------
it("request rejects a non-JSON content-type before streaming", async () => {
  const request = new Request("https://synthetic.example.test/api", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  await expect(readJsonRequestBody(request, 1024)).rejects.toMatchObject({
    reason: "content-type",
  });
});

it("request accepts application/json with parameters", async () => {
  const request = new Request("https://synthetic.example.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: '{"provider":"google"}',
  });
  await expect(readJsonRequestBody(request, 1024)).resolves.toEqual({
    provider: "google",
  });
});

// --- streamed bounds pin (auth/http, ai/http, mailbox, discovery) ------
it("streamed body above the cap rejects", async () => {
  const response = new Response(jsonStream(`{"pad":"${"x".repeat(2048)}"}`), {
    headers: { "content-length": "10" },
  });
  await expect(readJsonResponseBody(response, 256)).rejects.toMatchObject({
    reason: "too-large",
  });
});

it("excessive empty chunks reject even below the byte cap", async () => {
  const response = new Response(jsonStream("{}", 33));
  await expect(readJsonResponseBody(response, 1024)).rejects.toMatchObject({
    reason: "too-large",
  });
});

it("bounded empty and data chunks are accepted", async () => {
  const response = new Response(jsonStream('{"ok":true}', 32, 8));
  await expect(readJsonResponseBody(response, 1024)).resolves.toEqual({
    ok: true,
  });
});

it("missing body rejects as body-missing", async () => {
  const response = new Response(null, { status: 204 });
  await expect(readJsonResponseBody(response, 1024)).rejects.toMatchObject({
    reason: "body-missing",
  });
  const request = new Request("https://synthetic.example.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  await expect(readJsonRequestBody(request, 1024)).rejects.toMatchObject({
    reason: "body-missing",
  });
});

it("non-UTF-8 and non-JSON payloads reject as invalid-json", async () => {
  const badUtf8 = new Response(stream([new Uint8Array([0xff, 0xfe, 0xfd])]));
  await expect(readJsonResponseBody(badUtf8, 1024)).rejects.toMatchObject({
    reason: "invalid-json",
  });
  const badJson = new Response(jsonStream("not json"));
  await expect(readJsonResponseBody(badJson, 1024)).rejects.toMatchObject({
    reason: "invalid-json",
  });
});

it("abort and deadline failures reject as aborted", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
  });
  const pending = readJsonResponseBody(new Response(body), 1024, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ reason: "aborted" });

  await expect(
    readBoundedJson(stream([bytes("{}")]), 1024, {
      deadline: Date.now() - 1,
    }),
  ).rejects.toMatchObject({ reason: "aborted" });
});

function stalledBody(): ReadableStream<Uint8Array> {
  // pull never resolves and cancel never settles: only a raced deadline/abort
  // can end the read.
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      return new Promise(() => {});
    },
  });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("read did not settle")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

it("a stalled body whose cancel never settles rejects as aborted at the deadline", async () => {
  const started = Date.now();
  await expect(
    within(
      readJsonResponseBody(new Response(stalledBody()), 1024, {
        deadline: Date.now() + 50,
      }),
      2000,
    ),
  ).rejects.toMatchObject({ reason: "aborted" });
  expect(Date.now() - started).toBeLessThan(2000);
});

it("a stalled body whose cancel never settles rejects as aborted on signal abort", async () => {
  const controller = new AbortController();
  const pending = readJsonResponseBody(new Response(stalledBody()), 1024, {
    signal: controller.signal,
    deadline: Date.now() + 60000,
  });
  setTimeout(() => controller.abort(), 20);
  await expect(within(pending, 2000)).rejects.toMatchObject({
    reason: "aborted",
  });
});

it("an already-aborted signal rejects a stalled body without waiting", async () => {
  await expect(
    within(
      readBoundedJson(stalledBody(), 1024, { signal: AbortSignal.abort() }),
      2000,
    ),
  ).rejects.toMatchObject({ reason: "aborted" });
});

it("readBoundedJson is the shared primitive for request and response reads", async () => {
  await expect(readBoundedJson(jsonStream('{"a":1}'), 1024)).resolves.toEqual({
    a: 1,
  });
  await expect(readBoundedJson(null, 1024)).rejects.toMatchObject({
    reason: "body-missing",
  });
});

// --- 128 KiB response writer pin (worker json(), W8) -------------------
it("boundedJsonResponse keeps the 128 KiB response cap", async () => {
  expect(MAX_JSON_RESPONSE_BYTES).toBe(128 * 1024);
  const small = boundedJsonResponse({ ok: true });
  expect(small.status).toBe(200);
  expect(small.headers.get("Content-Type")).toBe(
    "application/json; charset=utf-8",
  );
  expect(small.headers.get("Cache-Control")).toBe("no-store");
  await expect(small.json()).resolves.toEqual({ ok: true });

  const pad = "y".repeat(MAX_JSON_RESPONSE_BYTES);
  expect(() => boundedJsonResponse({ pad })).toThrow(
    expect.objectContaining({ reason: "too-large" }),
  );

  const custom = boundedJsonResponse({ ok: true }, { status: 201 });
  expect(custom.status).toBe(201);
});

// --- Retry-After (G5) -------------------------------------------------
// Single malformed-date fallback: a non-numeric value that is not a strict
// HTTP-date is treated as absent (undefined), never as an elapsed
// Date.parse cooldown.
it.each([
  [undefined, undefined],
  [null, undefined],
  ["", undefined],
  ["30", 30000],
  ["0", 1000],
  ["1", 1000],
  ["86400", 86400000],
  ["86401", 86400001],
  ["9".repeat(129), 86400001],
  ["-1", undefined],
  ["+1", undefined],
  ["1.5", undefined],
  ["not a date", undefined],
  ["Wed, 14 Oct 2026 99:99:99 GMT", undefined],
  ["Wed, 01 Jan 2020 00:00:00 GMT", 1000],
] as const)("parseRetryAfter(%j) is %j", (value, expected) => {
  expect(parseRetryAfter(value, Date.UTC(2026, 9, 14))).toBe(expected);
});

it("parseRetryAfter keeps an exact future HTTP-date cooldown", () => {
  const now = Date.UTC(2026, 9, 14);
  expect(parseRetryAfter("Wed, 14 Oct 2026 00:02:00 GMT", now)).toBe(120000);
});

it("parseRetryAfter errors carry a stable reason", () => {
  expect(new BoundedJsonError("too-large").reason).toBe("too-large");
  expect(new BoundedJsonError("too-large").message).toBe("too-large");
});
