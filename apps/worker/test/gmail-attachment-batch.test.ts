import { expect, it, vi } from "vitest";
import { createGmailContentReader } from "../../../packages/adapters/src/pipeline/gmail-content";

const payload = {
  partId: "root",
  mimeType: "multipart/mixed",
  parts: Array.from({ length: 8 }, (_, index) => ({
    partId: `part-${index}`,
    mimeType: "text/plain",
    body: { size: 4, attachmentId: `attachment-${index}` },
  })),
};
function batchResponse(statuses = Array<number>(8).fill(200), ids?: string[]) {
  return new Response(
    `${statuses
      .map(
        (status, index) =>
          `--synthetic_batch\r\nContent-Type: application/http\r\nContent-ID: <response-${ids?.[index] ?? `attachment-${index}`}>\r\n\r\nHTTP/1.1 ${status} Synthetic\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(status === 200 ? { size: 4, data: "dGVzdA" } : { error: "synthetic" })}\r\n`,
      )
      .join("")}--synthetic_batch--\r\n`,
    {
      headers: {
        "Content-Type": 'multipart/mixed; boundary="synthetic_batch"',
      },
    },
  );
}
function fixture(response: () => Response = batchResponse) {
  const checkpoint = vi.fn(async () => true);
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url) === "https://gmail.googleapis.com/batch"
      ? response()
      : Response.json({ id: "message", payload }),
  );
  return {
    fetcher,
    checkpoint,
    controller,
    load: () =>
      createGmailContentReader("synthetic-token", { fetcher }).load({
        connectionId: "mailbox",
        providerMessageId: "message",
        checkpoint,
        signal: controller.signal,
      }),
  };
}
it("fetches eight bounded attachments in one authorized Gmail HTTP batch with exact identities", async () => {
  const current = fixture();
  const result = await current.load();
  expect(result.status).toBe("ready");
  expect(current.fetcher).toHaveBeenCalledTimes(2);
  expect(current.checkpoint).toHaveBeenCalledTimes(2);
  const [url, init] = current.fetcher.mock.calls[1] ?? [];
  expect(url).toBe("https://gmail.googleapis.com/batch");
  expect(init).toMatchObject({
    method: "POST",
    redirect: "manual",
    headers: { Authorization: "Bearer synthetic-token" },
  });
  for (let index = 0; index < 8; index++)
    expect(init?.body).toContain(
      `GET /gmail/v1/users/me/messages/message/attachments/attachment-${index} HTTP/1.1`,
    );
  if (result.status !== "ready") throw new Error("Expected source bytes");
  expect(result.input.root.children?.map((part) => part.bytes)).toEqual(
    Array.from({ length: 8 }, () => new TextEncoder().encode("test")),
  );
});
it.each([
  [401, "CONTENT_AUTH_REQUIRED"],
  [403, "CONTENT_UNAVAILABLE"],
  [404, "CONTENT_SOURCE_UNAVAILABLE"],
  [429, "CONTENT_UNAVAILABLE"],
  [503, "CONTENT_UNAVAILABLE"],
])(
  "inner HTTP %i fails the source before extraction and never retries inside the adapter",
  async (status, code) => {
    const statuses = Array<number>(8).fill(200);
    statuses[3] = status as number;
    const current = fixture(() => batchResponse(statuses));
    await expect(current.load()).rejects.toMatchObject({ code });
    expect(current.fetcher).toHaveBeenCalledTimes(2);
  },
);
it.each([
  Array(8).fill("attachment-0"),
  Array.from({ length: 8 }, (_, index) => `foreign-${index}`),
])("rejects duplicate or foreign response identities", async (ids) => {
  const current = fixture(() => batchResponse(undefined, ids));
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_UNAVAILABLE",
  });
});
it("revocation after message metadata prevents all attachment downloads", async () => {
  const current = fixture();
  current.checkpoint.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_AUTH_CHANGED",
  });
  expect(current.fetcher).toHaveBeenCalledTimes(1);
});
it("an already aborted lease never fetches message metadata", async () => {
  const current = fixture();
  current.controller.abort();
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_AUTH_CHANGED",
  });
  expect(current.fetcher).not.toHaveBeenCalled();
});

it("mixed retryable failures retain the strictest Retry-After without exposing successful partial bytes", async () => {
  const current = fixture(() => {
    const response = batchResponse([200, 429, 503, 200, 200, 200, 200, 200]);
    return new Response(response.body, response);
  });
  current.fetcher.mockImplementation(async (url) => {
    if (String(url) !== "https://gmail.googleapis.com/batch")
      return Response.json({ id: "message", payload });
    const response = batchResponse([200, 429, 503, 200, 200, 200, 200, 200]);
    const text = new TextDecoder()
      .decode(await response.arrayBuffer())
      .replace(
        "HTTP/1.1 429 Synthetic\r\n",
        "HTTP/1.1 429 Synthetic\r\nRetry-After: 60\r\n",
      )
      .replace(
        "HTTP/1.1 503 Synthetic\r\n",
        "HTTP/1.1 503 Synthetic\r\nRetry-After: 120\r\n",
      );
    return new Response(text, response);
  });
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_UNAVAILABLE",
    retryAfterMs: 120000,
  });
  expect(current.fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  (text: string) =>
    text.replace("<response-attachment-7>", "<response-attachment-8>"),
  (text: string) => text.replace("--synthetic_batch--\r\n", ""),
  (text: string) =>
    text.replace("\r\n--synthetic_batch\r\n", "\r\n--synthetic_batchXX"),
  (text: string) =>
    text.replace("Content-Type: application/http", "Content-Type: text/plain"),
  (text: string) => text.replace("HTTP/1.1 200 Synthetic", "not HTTP"),
])("rejects malformed bounded multipart responses", async (mutate) => {
  const current = fixture();
  current.fetcher.mockImplementation(async (url) => {
    if (String(url) !== "https://gmail.googleapis.com/batch")
      return Response.json({ id: "message", payload });
    const response = batchResponse();
    return new Response(
      mutate(new TextDecoder().decode(await response.arrayBuffer())),
      response,
    );
  });
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_UNAVAILABLE",
  });
});
it("aggregate encoded bytes include both metadata and batch framing", async () => {
  let canceled = false;
  const current = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          },
          cancel() {
            canceled = true;
          },
        }),
        {
          headers: {
            "Content-Type": "multipart/mixed; boundary=synthetic_batch",
          },
        },
      ),
  );
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_BYTE_LIMIT",
  });
  expect(canceled).toBe(true);
});
it("cancellation during a batch body discards all partial content and cancels the reader", async () => {
  const current = fixture();
  let canceled = false;
  current.fetcher.mockImplementation(async (url) => {
    if (String(url) !== "https://gmail.googleapis.com/batch")
      return Response.json({ id: "message", payload });
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(
              new TextEncoder().encode("--synthetic_batch\r\n"),
            );
            current.controller.abort();
          },
          cancel() {
            canceled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_AUTH_CHANGED",
  });
  expect(canceled).toBe(true);
});
it.each([
  ["30", 30000],
  ["-bad-", undefined],
  ["99999999999999999999999999999999999999999999999", 86400001],
  ["86401", 86400001],
  ["Wed, 01 Jan 2020 00:00:00 GMT", 1000],
])(
  "bounds Retry-After %s without shortening unsupported long cooldowns",
  async (header, expected) => {
    const { retryAfterMs } =
      await import("../../../packages/adapters/src/pipeline/gmail-batch");
    expect(retryAfterMs(header as string)).toBe(expected);
  },
);
it("mixed authentication failure and oversized cooldown keep reconnect as the recovery path", async () => {
  const current = fixture();
  current.fetcher.mockImplementation(async (url) => {
    if (String(url) !== "https://gmail.googleapis.com/batch")
      return Response.json({ id: "message", payload });
    const response = batchResponse([200, 401, 429, 200, 200, 200, 200, 200]);
    const text = new TextDecoder()
      .decode(await response.arrayBuffer())
      .replace(
        "HTTP/1.1 429 Synthetic\r\n",
        `HTTP/1.1 429 Synthetic\r\nRetry-After: ${"9".repeat(129)}\r\n`,
      );
    return new Response(text, response);
  });
  try {
    await current.load();
    throw new Error("Expected auth failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "CONTENT_AUTH_REQUIRED" });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  }
});
it.each(["-1", "+1", "not a date", "1.5"])(
  "malformed Retry-After %s cannot become an elapsed Date.parse cooldown",
  async (header) => {
    const { retryAfterMs } =
      await import("../../../packages/adapters/src/pipeline/gmail-batch");
    expect(retryAfterMs(header)).toBeUndefined();
  },
);
it("oversized numeric cooldown is a pause sentinel rather than an early retry", async () => {
  const { retryAfterMs } =
    await import("../../../packages/adapters/src/pipeline/gmail-batch");
  expect(retryAfterMs("9".repeat(129))).toBe(86400001);
});
it("a valid future HTTP-date retains its exact cooldown", async () => {
  const { retryAfterMs } =
    await import("../../../packages/adapters/src/pipeline/gmail-batch");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 14));
  try {
    expect(retryAfterMs("Wed, 14 Oct 2026 00:02:00 GMT")).toBe(120000);
  } finally {
    clock.mockRestore();
  }
});
it("outer Retry-After is retained when stricter than any inner retryable failure", async () => {
  const current = fixture();
  current.fetcher.mockImplementation(async (url) => {
    if (String(url) !== "https://gmail.googleapis.com/batch")
      return Response.json({ id: "message", payload });
    const response = batchResponse([429, 200, 200, 200, 200, 200, 200, 200]);
    response.headers.set("Retry-After", "180");
    return response;
  });
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_UNAVAILABLE",
    retryAfterMs: 180000,
  });
});
it.each(["SERVICE_DISABLED", "insufficientPermissions"])(
  "inner403 %s preserves the direct content reader's unavailable boundary",
  async (reason) => {
    const current = fixture();
    current.fetcher.mockImplementation(async (url) => {
      if (String(url) !== "https://gmail.googleapis.com/batch")
        return Response.json({ id: "message", payload });
      const response = batchResponse([403, 200, 200, 200, 200, 200, 200, 200]);
      const text = new TextDecoder()
        .decode(await response.arrayBuffer())
        .replace(
          '{"error":"synthetic"}',
          JSON.stringify({ error: { errors: [{ reason }] } }),
        );
      return new Response(text, response);
    });
    await expect(current.load()).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
  },
);
it("delimiter floods fail within the fixed multipart part budget", async () => {
  const current = fixture(
    () =>
      new Response(
        `--synthetic_batch\r\n${"\r\n--synthetic_batch\r\n".repeat(10000)}--synthetic_batch--\r\n`,
        {
          headers: {
            "Content-Type": "multipart/mixed; boundary=synthetic_batch",
          },
        },
      ),
  );
  await expect(current.load()).rejects.toMatchObject({
    code: "CONTENT_UNAVAILABLE",
  });
  expect(current.fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  [
    "Content-Type: application/http\r\n",
    "Content-Transfer-Encoding: base64\r\n",
  ],
  ["HTTP/1.1 200 Synthetic\r\n", "Content-Encoding: gzip\r\n"],
  ["HTTP/1.1 200 Synthetic\r\n", "Transfer-Encoding: chunked\r\n"],
])(
  "unsupported inner encoding after %s cannot pass as decoded JSON",
  async (location, encoding) => {
    const current = fixture();
    current.fetcher.mockImplementation(async (url) => {
      if (String(url) !== "https://gmail.googleapis.com/batch")
        return Response.json({ id: "message", payload });
      const response = batchResponse();
      const text = new TextDecoder()
        .decode(await response.arrayBuffer())
        .replace(location, `${location}${encoding}`);
      return new Response(text, response);
    });
    await expect(current.load()).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
    });
  },
);
it.each(["binary", "identity"])(
  "explicit MIME %s and identity HTTP encodings preserve source content",
  async (encoding) => {
    const current = fixture();
    current.fetcher.mockImplementation(async (url) => {
      if (String(url) !== "https://gmail.googleapis.com/batch")
        return Response.json({ id: "message", payload });
      const response = batchResponse();
      const text = new TextDecoder()
        .decode(await response.arrayBuffer())
        .replace(
          "Content-Type: application/http\r\n",
          `Content-Type: application/http\r\nContent-Transfer-Encoding: ${encoding}\r\n`,
        )
        .replace(
          "HTTP/1.1 200 Synthetic\r\n",
          "HTTP/1.1 200 Synthetic\r\nContent-Encoding: identity\r\nTransfer-Encoding: identity\r\n",
        );
      return new Response(text, response);
    });
    expect((await current.load()).status).toBe("ready");
  },
);
