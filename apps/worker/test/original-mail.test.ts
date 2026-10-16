import { afterEach, expect, it, vi } from "vitest";
import { createOriginalMailReader } from "../../../packages/adapters/src/documents/original-mail";

afterEach(() => vi.restoreAllMocks());
const id = "AAkOriginal+/==";
const header = new TextEncoder().encode(
  "From: source@example.invalid\r\nSubject: ",
);
const tail = new TextEncoder().encode(
  "\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n",
);
const original = new Uint8Array([
  ...header,
  0xe9,
  ...tail,
  0,
  0xff,
  0x80,
  13,
  10,
]);
const policy = { maxOriginalBytes: 4096, deadlineMs: 1000 };
it("Outlook original preserves exact CRLF, eight-bit headers and binary bytes", async () => {
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    ++calls === 1
      ? Response.json({ id })
      : new Response(original, {
          headers: { "content-type": "message/rfc822" },
        }),
  );
  const result = await createOriginalMailReader({
    provider: "outlook",
    accessToken: "synthetic-original-access",
    policy,
  }).read({ providerMessageId: id, signal: new AbortController().signal });
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Synthetic original not returned");
  expect(result.bytes).toEqual(original);
});
const gmailId = "synthetic-original-message";
const encodeRaw = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
const inputFor = (
  provider: "gmail" | "outlook",
  signal = new AbortController().signal,
) => ({ providerMessageId: provider === "gmail" ? gmailId : id, signal });
function reader(provider: "gmail" | "outlook", limits = policy) {
  return createOriginalMailReader({
    provider,
    accessToken: "synthetic-original-access",
    policy: limits,
  });
}
function replies(...values: (unknown | Response)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    calls.push({ url: String(request), init });
    const value = values.shift();
    if (value === undefined)
      throw new Error("Unexpected synthetic original request");
    return value instanceof Response ? value : Response.json(value);
  });
  return calls;
}
it.each([false, true])(
  "Gmail raw preserves all MIME bytes with optional canonical padding (%s)",
  async (padded) => {
    const raw = encodeRaw(original);
    const calls = replies({
      id: gmailId,
      raw: padded ? raw + "=".repeat((4 - (raw.length % 4)) % 4) : raw,
    });
    const result = await reader("gmail").read(inputFor("gmail"));
    expect(result).toEqual({
      status: "ready",
      bytes: original,
      mimeType: "message/rfc822",
      extension: ".eml",
      providerMessageId: gmailId,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(url.pathname).toBe(`/gmail/v1/users/me/messages/${gmailId}`);
    expect(url.searchParams.get("format")).toBe("raw");
    expect(url.searchParams.get("fields")).toBe("id,raw");
    expect(calls[0]?.init?.redirect).toBe("manual");
  },
);
it("Gmail archive reader preserves every byte of a six-MiB binary EML under the existing ten-second deadline", async () => {
  const bodySize = 6 * 1024 * 1024;
  const mimeHeader =
    "From: synthetic@example.test\r\nSubject: Synthetic \u00e9\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n";
  const pattern = String.fromCharCode(
    ...new Uint8Array(256).map((_, index) => index),
  );
  const binary = `${mimeHeader}${pattern.repeat(bodySize / 256)}\r\n`;
  const expected = new Uint8Array(mimeHeader.length + bodySize + 2);
  for (let index = 0; index < mimeHeader.length; index++)
    expected[index] = mimeHeader.charCodeAt(index);
  for (let index = 0; index < bodySize; index++)
    expected[mimeHeader.length + index] = index % 256;
  expected[expected.length - 2] = 13;
  expected[expected.length - 1] = 10;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      id: gmailId,
      raw: btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    }),
  );
  const result = await createOriginalMailReader(
    {
      provider: "gmail",
      accessToken: "synthetic-original-access",
      policy: { maxOriginalBytes: 4 * 1024 * 1024, deadlineMs: 10000 },
    },
    { fetcher, archiveByteLimit: 16 * 1024 * 1024 },
  ).read(inputFor("gmail"));
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Synthetic Gmail archive original unavailable");
  expect(result.bytes.length).toBe(expected.length);
  expect(result.mimeType).toBe("message/rfc822");
  expect(result.providerMessageId).toBe(gmailId);
  expect(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(result.bytes)),
    ),
  ).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", expected)));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  "message/rfc822",
  "text/plain; charset=utf-8",
  "application/octet-stream",
])("Graph compatible transport MIME %s never recodes content", async (type) => {
  const calls = replies(
    { id },
    new Response(original, { headers: { "content-type": type } }),
  );
  expect(await reader("outlook").read(inputFor("outlook"))).toMatchObject({
    status: "ready",
    bytes: original,
    mimeType: "message/rfc822",
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.url).toBe(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/$value`,
  );
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get("Prefer")).toContain(
      'IdType="ImmutableId"',
    );
    expect(call.init?.redirect).toBe("manual");
  }
});
it.each(["gmail", "outlook"] as const)(
  "%s mismatched provider ID refuses original bytes without any fallback",
  async (provider) => {
    const calls = replies({
      id: "synthetic-other-message",
      raw: encodeRaw(original),
    });
    expect(await reader(provider).read(inputFor(provider))).toEqual({
      status: "unsupported",
      code: "source_mismatch",
    });
    expect(calls).toHaveLength(1);
  },
);
it.each(["AB", "AAAA===", "A", "AAAA+", "AA=A", "AAAA\n", "AA===="])(
  "noncanonical Gmail encoding %s cannot manufacture an original",
  async (raw) => {
    replies({ id: gmailId, raw });
    expect(await reader("gmail").read(inputFor("gmail"))).toEqual({
      status: "unsupported",
      code: "invalid_encoding",
    });
  },
);
it.each(["gmail", "outlook"] as const)(
  "%s over-original bound yields no truncated bytes",
  async (provider) => {
    replies(
      ...(provider === "gmail"
        ? [{ id: gmailId, raw: encodeRaw(original) }]
        : [
            { id },
            new Response(original, {
              headers: { "content-type": "message/rfc822" },
            }),
          ]),
    );
    expect(
      await reader(provider, { maxOriginalBytes: 32, deadlineMs: 1000 }).read(
        inputFor(provider),
      ),
    ).toEqual({ status: "unsupported", code: "byte_limit" });
  },
);
it.each(["text/html", "application/json", "image/png"])(
  "Graph content type %s cannot be labeled MIME original",
  async (type) => {
    replies(
      { id },
      new Response(original, { headers: { "content-type": type } }),
    );
    expect(await reader("outlook").read(inputFor("outlook"))).toEqual({
      status: "unsupported",
      code: "unsupported_type",
    });
  },
);
it("Gmail raw endpoint must have JSON media type", async () => {
  replies(
    new Response(JSON.stringify({ id: gmailId, raw: encodeRaw(original) }), {
      headers: { "content-type": "text/html" },
    }),
  );
  expect(await reader("gmail").read(inputFor("gmail"))).toEqual({
    status: "unsupported",
    code: "unsupported_type",
  });
});
it.each([
  "",
  "<html>synthetic generated preview</html>",
  "not MIME\r\n\r\nbody",
])(
  "non-original payload %s is explicit unsupported rather than synthetic HTML/PDF generation",
  async (value) => {
    replies(
      { id },
      new Response(value, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(await reader("outlook").read(inputFor("outlook"))).toEqual({
      status: "unsupported",
      code: "invalid_original",
    });
  },
);
it.each(["gmail", "outlook"] as const)(
  "%s missing source is controlled and cancels unconsumed body",
  async (provider) => {
    let canceled = false;
    const calls = replies(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
          },
        }),
        { status: 404 },
      ),
    );
    expect(await reader(provider).read(inputFor(provider))).toEqual({
      status: "source_unavailable",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  },
);
it.each([401, 403, 429, 503, 302])(
  "status %s is typed, redacted and never follows redirect or returns phantom bytes",
  async (status) => {
    let canceled = false;
    const calls = replies(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
            return new Promise<void>(() => {});
          },
        }),
        {
          status,
          headers: {
            Location: "https://evil.example/original",
            "Retry-After": "120",
          },
        },
      ),
    );
    await expect(
      reader("outlook").read(inputFor("outlook")),
    ).rejects.toMatchObject({
      code:
        status === 401 || status === 403
          ? "AUTH_REQUIRED"
          : status === 429 || status === 503
            ? "RATE_LIMITED"
            : "UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  },
);
it.each([
  ["120", 120000],
  ["not-a-date", 30000],
  ["2026-10-14T00:00:00Z", 30000],
  ["999999999999999999999999", 86400001],
] as const)(
  "rate-limited original read with Retry-After %s uses the shared G5 parser (%s ms)",
  async (header, expected) => {
    replies(
      new Response(null, { status: 429, headers: { "Retry-After": header } }),
    );
    await expect(
      reader("outlook").read(inputFor("outlook")),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expected });
  },
);
it("Gmail advertised and chunked JSON overhead is bounded independently of decoded byte limit", async () => {
  const calls = replies(
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "9999999",
      },
    }),
    new Response("x".repeat(20000), {
      headers: { "content-type": "application/json" },
    }),
  );
  for (let i = 0; i < 2; i++)
    expect(
      await reader("gmail", { maxOriginalBytes: 64, deadlineMs: 1000 }).read(
        inputFor("gmail"),
      ),
    ).toEqual({ status: "unsupported", code: "byte_limit" });
  expect(calls).toHaveLength(2);
});
it("Graph raw advertised over-limit cancels body and does not return any partial original", async () => {
  let canceled = false;
  const calls = replies(
    { id },
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-type": "message/rfc822",
          "content-length": "99999",
        },
      },
    ),
  );
  expect(await reader("outlook").read(inputFor("outlook"))).toEqual({
    status: "unsupported",
    code: "byte_limit",
  });
  expect(canceled).toBe(true);
  expect(calls[1]?.init?.signal?.aborted).toBe(true);
});
it.each(["gmail", "outlook"] as const)(
  "invalid %s source IDs cannot choose URLs or accounts",
  async (provider) => {
    const calls = replies();
    await expect(
      reader(provider).read({
        providerMessageId: "../../users/other?format=full",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  },
);
it.each([
  { maxOriginalBytes: 0, deadlineMs: 1000 },
  { maxOriginalBytes: 4 * 1024 * 1024 + 1, deadlineMs: 1000 },
  { maxOriginalBytes: 4096, deadlineMs: 99 },
  { maxOriginalBytes: 4096, deadlineMs: 10001 },
])(
  "server policy %j cannot exceed supported operation bounds",
  async (limits) => {
    const calls = replies();
    expect(() => reader("gmail", limits)).toThrow("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  },
);
it("already canceled operation makes zero provider calls", async () => {
  const calls = replies();
  const controller = new AbortController();
  controller.abort();
  await expect(
    reader("gmail").read(inputFor("gmail", controller.signal)),
  ).rejects.toMatchObject({ code: "CANCELED" });
  expect(calls).toHaveLength(0);
});
it("caller abort interrupts noncooperative body and releases only owned signal", async () => {
  const caller = new AbortController();
  let canceled = false;
  const calls = replies(
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
          setTimeout(() => caller.abort(), 10);
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await expect(
    reader("gmail").read(inputFor("gmail", caller.signal)),
  ).rejects.toMatchObject({ code: "CANCELED" });
  expect(canceled).toBe(true);
  expect(calls[0]?.init?.signal?.aborted).toBe(true);
});
it("late HTTP response after caller abort is observed and its body canceled", async () => {
  let respond: ((response: Response) => void) | undefined;
  let canceled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  const caller = new AbortController();
  const operation = reader("gmail").read(inputFor("gmail", caller.signal));
  caller.abort();
  await expect(operation).rejects.toMatchObject({ code: "CANCELED" });
  if (!respond) throw new Error("Synthetic pending request missing");
  respond(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(canceled).toBe(true);
});
it("aggregate deadline spans Graph metadata and original reads and cancels late body", async () => {
  // Fake clock: the 100 ms deadline must cover the metadata call and the
  // original read together. Real sleeps raced the runner (a slow first call
  // alone could pass 100 ms), so time is advanced explicitly instead.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let calls = 0;
    let canceled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (++calls === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        return Response.json({ id });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "message/rfc822" } },
      );
    });
    const caller = new AbortController();
    let settled = false;
    const read = reader("outlook", {
      maxOriginalBytes: 4096,
      deadlineMs: 100,
    })
      .read(inputFor("outlook", caller.signal))
      .finally(() => {
        settled = true;
      });
    const rejected = expect(read).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toBe(2);
    // 99 ms after the start: still inside the one aggregate deadline.
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    // 100 ms: a per-request deadline would allow the original read until
    // 160 ms; the aggregate one ends the read and cancels the late body now.
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(canceled).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
function fragmented(body: Uint8Array, chunkSize: number, emptyChunks = 0) {
  let offset = 0,
    empty = 0,
    pulls = 0,
    canceled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (empty++ < emptyChunks) {
          controller.enqueue(new Uint8Array(0));
          return;
        }
        if (offset === body.length) {
          controller.close();
          return;
        }
        const finish = Math.min(body.length, offset + chunkSize);
        controller.enqueue(body.subarray(offset, finish));
        offset = finish;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, {
      headers: { "content-type": "application/json" },
    }),
    state: () => ({ pulls, canceled }),
  };
}
it.each(["empty", "tiny"] as const)(
  "excessive %s chunks fail closed below the byte bound and cancel without partial original",
  async (kind) => {
    const bytes =
      kind === "tiny"
        ? new Uint8Array([...original, ...new Uint8Array(5000).fill(88)])
        : original;
    const body = new TextEncoder().encode(
      JSON.stringify({ id: gmailId, raw: encodeRaw(bytes) }),
    );
    const fragmentedBody = fragmented(
      body,
      kind === "tiny" ? 1 : body.length,
      kind === "empty" ? 33 : 0,
    );
    replies(fragmentedBody.response);
    await expect(
      reader("gmail", { maxOriginalBytes: 16384, deadlineMs: 1000 }).read(
        inputFor("gmail"),
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fragmentedBody.state().canceled).toBe(true);
    expect(fragmentedBody.state().pulls).toBeLessThanOrEqual(
      kind === "empty" ? 33 : 4097,
    );
  },
);
it("normal fragmented MIME JSON remains exactly byte faithful", async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: gmailId, raw: encodeRaw(original) }),
  );
  const fragmentedBody = fragmented(body, 7, 2);
  replies(fragmentedBody.response);
  expect(await reader("gmail").read(inputFor("gmail"))).toMatchObject({
    status: "ready",
    bytes: original,
  });
});
it("elapsed deadline is checked between immediately resolved chunk reads", async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: gmailId, raw: encodeRaw(original) }),
  );
  const fragmentedBody = fragmented(body, 7);
  replies(fragmentedBody.response);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 25));
  await expect(
    reader("gmail", { maxOriginalBytes: 4096, deadlineMs: 100 }).read(
      inputFor("gmail"),
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(fragmentedBody.state().pulls).toBeLessThanOrEqual(4);
  expect(fragmentedBody.state().canceled).toBe(true);
});
