import { describe, expect, it, vi } from "vitest";
import {
  type FxReferenceBindings,
  FxReferenceError,
  fxReferenceConfiguration,
} from "../../../packages/adapters/src/fx/configuration";
import {
  createPublicReferenceRateReader,
  type FxReferenceTransport,
} from "../../../packages/adapters/src/fx/reference";

const config = {
  adapter: "frankfurter-v2" as const,
  source: "ecb" as const,
  maxPriorAgeDays: 2,
  timeoutMs: 100,
};
const request = {
  fromCurrency: "EUR",
  toCurrency: "USD",
  requestedDate: "2026-10-11",
};
const retrievedAt = 1791676800000;
const response = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const row = (date: string, rate = "1.123456789012345678") =>
  `{"date":"${date}","base":"EUR","quote":"USD","rate":${rate}}`;

describe("T19 bounded public reference adapter", () => {
  it("selects latest preceding eligible provider date and preserves exact numeric lexeme", async () => {
    const captured: Request[] = [];
    const transport: FxReferenceTransport = async (incoming) => {
      captured.push(incoming);
      return response(`[${row("2026-10-09")},${row("2026-10-10", "1.05")}]`);
    };
    const quote = await createPublicReferenceRateReader(
      config,
      transport,
      () => retrievedAt,
    ).lookup(request);
    expect(quote).toMatchObject({
      ...request,
      effectiveDate: "2026-10-10",
      rate: "1.05",
      source: "ecb",
      retrievedAt,
    });
    expect(captured).toHaveLength(1);
    const actual = captured[0];
    expect(actual).toBeDefined();
    if (!actual) throw new Error("Missing captured request");
    expect(actual.url).toBe(
      "https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=USD&from=2026-10-09&to=2026-10-11",
    );
    expect(actual.method).toBe("GET");
    expect(actual.redirect).toBe("manual");
    expect(actual.headers.has("Cookie")).toBe(false);
    expect(actual.headers.has("Authorization")).toBe(false);
    expect([...actual.headers]).toEqual([["accept", "application/json"]]);
    expect(await actual.text()).toBe("");
    const exact = await createPublicReferenceRateReader(
      config,
      async () => response(`[${row("2026-10-09")}]`),
      () => retrievedAt,
    ).lookup(request);
    expect(exact?.rate).toBe("1.123456789012345678");
  });
  it("is disabled without explicit operator selections and rejects invalid enabled configuration", () => {
    expect(fxReferenceConfiguration({})).toBeNull();
    expect(
      fxReferenceConfiguration({ FX_REFERENCE_ENABLED: "false" }),
    ).toBeNull();
    const enabled = {
      FX_REFERENCE_ENABLED: "true",
      FX_REFERENCE_ADAPTER: "frankfurter-v2",
      FX_REFERENCE_SOURCE: "ecb",
      FX_MAX_PRIOR_AGE_DAYS: "2",
      FX_REFERENCE_TIMEOUT_MS: "100",
    };
    expect(fxReferenceConfiguration(enabled)).toEqual(config);
    const missingSource: FxReferenceBindings = { ...enabled };
    delete missingSource.FX_REFERENCE_SOURCE;
    const missingAge: FxReferenceBindings = { ...enabled };
    delete missingAge.FX_MAX_PRIOR_AGE_DAYS;
    expect(() => fxReferenceConfiguration(missingSource)).toThrow(
      "FX_REFERENCE_INVALID_CONFIGURATION",
    );
    expect(() => fxReferenceConfiguration(missingAge)).toThrow(
      "FX_REFERENCE_INVALID_CONFIGURATION",
    );
    for (const invalid of [
      { FX_REFERENCE_ADAPTER: "unknown" },
      { FX_REFERENCE_SOURCE: "blended" },
      { FX_MAX_PRIOR_AGE_DAYS: "32" },
      { FX_MAX_PRIOR_AGE_DAYS: "02" },
      { FX_REFERENCE_TIMEOUT_MS: "99" },
      { FX_REFERENCE_ENABLED: "yes" },
    ])
      expect(() =>
        fxReferenceConfiguration({ ...enabled, ...invalid }),
      ).toThrow("FX_REFERENCE_INVALID_CONFIGURATION");
  });
  it("returns missing for stale/empty/404/422 data without retry or rate1", async () => {
    for (const result of [
      response(`[${row("2026-10-08")}]`),
      response("[]"),
      response("private-error", 404),
      response("private-error", 422),
    ]) {
      let calls = 0;
      const quote = await createPublicReferenceRateReader(config, async () => {
        calls++;
        return result;
      }).lookup(request);
      expect(quote).toBeNull();
      expect(calls).toBe(1);
    }
  });
  it.each([
    `[${row("2026-10-12")},${row("2026-10-09")}]`,
    `[${row("2026-10-09")},${row("2026-10-09", "2")}]`,
    `[${row("2026-10-09").replace('"USD"', '"GBP"')}]`,
    '[{"date":"2026-10-09","base":"EUR","quote":"USD","rate":1,"rate":2}]',
    '[{"date":"2026-10-09","base":"EUR","quote":"USD","rate":1,"unknown":"x"}]',
    '[{"date":"2026-10-09","base":"EUR","quote":"USD","rate":"1"}]',
    `[${row("2026-10-09", "0")}]`,
    `[${row("2026-10-09", "-1")}]`,
    `[${row("2026-10-09", "1e0")}]`,
    `[${row("2026-10-09", "1.1234567890123456789")}]`,
    `[${row("2026-02-30")}]`,
    `[${row("2026-10-09")},]`,
    "not-json",
    `[${Array.from({ length: 33 }, () => row("2026-10-09")).join(",")}]`,
  ])("fails closed for malformed/mismatched public rows %s", async (body) => {
    await expect(
      createPublicReferenceRateReader(config, async () =>
        response(body),
      ).lookup(request),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects redirects/status/media/length limits without following another destination", async () => {
    for (const result of [
      response("", 302, { Location: "https://evil.test" }),
      response("[]", 200, { "content-type": "text/html" }),
      response("[]", 200, { "content-length": "16385" }),
      response(" ".repeat(16385)),
      response("error", 500),
      response("error", 429),
    ]) {
      let calls = 0;
      await expect(
        createPublicReferenceRateReader(config, async () => {
          calls++;
          return result;
        }).lookup(request),
      ).rejects.toBeInstanceOf(FxReferenceError);
      expect(calls).toBe(1);
    }
  });
  it("aborts bounded transport and response reads, exposing no response text", async () => {
    let signal: AbortSignal | null = null;
    const reader = createPublicReferenceRateReader(config, async (incoming) => {
      signal = incoming.signal;
      return await new Promise<Response>(() => undefined);
    });
    await expect(reader.lookup(request)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(signal).not.toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
    });
    await expect(
      createPublicReferenceRateReader(
        config,
        async () =>
          new Response(stream, {
            headers: { "content-type": "application/json" },
          }),
      ).lookup(request),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("keeps unsupported/identity/malformed requests from any network call", async () => {
    let calls = 0;
    const reader = createPublicReferenceRateReader(config, async () => {
      calls++;
      return response("[]");
    });
    expect(await reader.lookup({ ...request, fromCurrency: "XYZ" })).toBeNull();
    expect(await reader.lookup({ ...request, toCurrency: "EUR" })).toBeNull();
    await expect(
      reader.lookup({ ...request, requestedDate: "2026-02-30" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      reader.lookup({ ...request, userId: "untrusted" } as typeof request),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(0);
  });
  it("clamps preceding range to Gregorian year1 without Date.UTC year reinterpretation", async () => {
    let url = "";
    expect(
      await createPublicReferenceRateReader(config, async (incoming) => {
        url = incoming.url;
        return response("[]");
      }).lookup({ ...request, requestedDate: "0001-01-01" }),
    ).toBeNull();
    expect(new URL(url).searchParams.get("from")).toBe("0001-01-01");
  });
});

it("cancels a late response body when the transport ignores deadline abort", async () => {
  let resolveResponse: (value: Response) => void = () => {
    throw new Error("Transport not called");
  };
  let cancelled = 0;
  let calls = 0;
  const deferred = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const reader = createPublicReferenceRateReader(config, async () => {
    calls++;
    return deferred;
  });
  await expect(reader.lookup(request)).rejects.toMatchObject({
    code: "timeout",
  });
  resolveResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(cancelled).toBe(1);
});

it("cancels received unread missing/error/media/oversize bodies before returning", async () => {
  for (const [status, headers, expected] of [
    [404, {}, null],
    [422, {}, null],
    [500, {}, "unavailable"],
    [302, { Location: "https://evil.test" }, "invalid_response"],
    [200, { "content-type": "text/html" }, "invalid_response"],
    [200, { "content-length": "16385" }, "invalid_response"],
  ] as const) {
    let cancelled = 0;
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const reader = createPublicReferenceRateReader(config, async () => {
      calls++;
      return new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    });
    if (expected === null) expect(await reader.lookup(request)).toBeNull();
    else
      await expect(reader.lookup(request)).rejects.toMatchObject({
        code: expected,
      });
    expect(calls).toBe(1);
    expect(cancelled).toBe(1);
  }
});

it("rejects33 finite empty chunks before a valid public payload", async () => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index++ < 33) controller.enqueue(new Uint8Array());
      else if (index === 34) controller.enqueue(new TextEncoder().encode("[]"));
      else controller.close();
    },
  });
  await expect(
    createPublicReferenceRateReader(
      config,
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    ).lookup(request),
  ).rejects.toMatchObject({ code: "invalid_response" });
});

it("rejects over4096 finite tiny chunks despite valid under-bytecap JSON", async () => {
  const payload = new TextEncoder().encode(`${" ".repeat(4100)}[]`);
  let index = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < payload.length)
        controller.enqueue(payload.subarray(index, ++index));
      else controller.close();
    },
    cancel() {
      cancelled++;
    },
  });
  await expect(
    createPublicReferenceRateReader(
      // The chunk cap, not the 100 ms deadline, must be what rejects this body,
      // even when the host is busy streaming 4097 one-byte reads.
      { ...config, timeoutMs: 10000 },
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    ).lookup(request),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(index).toBeLessThanOrEqual(4098);
  expect(cancelled).toBe(1);
});

it("accepts ordinary fragmented exact-decimal JSON within all stream bounds", async () => {
  const payload = `[${row("2026-10-09")}]`;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.length) {
        controller.close();
        return;
      }
      controller.enqueue(
        new TextEncoder().encode(payload.slice(offset, offset + 7)),
      );
      offset += 7;
    },
  });
  expect(
    await createPublicReferenceRateReader(
      config,
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
      () => retrievedAt,
    ).lookup(request),
  ).toMatchObject({
    rate: "1.123456789012345678",
    effectiveDate: "2026-10-09",
  });
});

it.each(["before-read", "after-read"] as const)(
  "enforces elapsed deadline %s without relying on delayed timer callback",
  async (phase) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let reads = 0;
    try {
      const reader = createPublicReferenceRateReader(config, async () => {
        if (phase === "before-read") now.mockReturnValue(1101);
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                reads++;
                now.mockReturnValue(1101);
                controller.enqueue(new TextEncoder().encode("[]"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/json" } },
        );
      });
      await expect(reader.lookup(request)).rejects.toMatchObject({
        code: "timeout",
      });
      expect(reads).toBe(phase === "before-read" ? 0 : 1);
    } finally {
      now.mockRestore();
    }
  },
);
