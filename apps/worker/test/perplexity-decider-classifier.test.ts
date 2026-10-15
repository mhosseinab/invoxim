import type { ApprovedAiConfig } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPerplexityEmailClassifier,
  PERPLEXITY_DECISIONS_ENDPOINT,
} from "../../../packages/adapters/src/ai/perplexity-decider";

/** AI-CLASSIFIER-PROVIDER: synthetic Perplexity Decisions API transport; fetch is always mocked. */
const KEY = "synthetic-perplexity-key-not-real";
const config: ApprovedAiConfig = {
  destinationId: "perplexity-decider",
  modelId: "pplx-decider-v1.1-27b",
  mode: "hosted",
  settingsRevision: 1,
  consentId: "consent",
  fingerprint: "c".repeat(64),
  promptVersion: "email-classification-v1",
  schemaVersion: 1,
  maxInputBytes: 24000,
  maxOutputBytes: 4096,
  maxOutputTokens: 1,
  maxAttempts: 1,
  reservationUnits: 30000,
};
const parts = [
  { id: "body", text: "Synthetic software invoice EUR 15, unpaid" },
];
const answer = (noul = 0.97, model = "pplx-decider-v1.1-27b") => ({
  model,
  answers: {
    receipt: { type: "noul", noul },
    documentType: {
      type: "choice",
      choice: noul <= 0.1 ? "delivery" : "invoice",
      probabilities: { [noul <= 0.1 ? "delivery" : "invoice"]: 1 },
      confidence: 1,
    },
    category: {
      type: "choice",
      choice: "software",
      probabilities: { software: 0.9, uncategorized: 0.1 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 1200, output_tokens: 0 },
});
const classifier = (options: { timeoutMs?: number } = {}) =>
  createPerplexityEmailClassifier(KEY, "pplx-decider-v1.1-27b", {
    timeoutMs: options.timeoutMs ?? 1000,
    negativeThreshold: 0.1,
    positiveThreshold: 0.9,
    categoryThreshold: 0.5,
  });
function mockFetch(response: () => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response());
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("AI-CLASSIFIER-PROVIDER sends one fixed Bearer POST with exactly model, state and questions", async () => {
  const fetch = mockFetch(() => Response.json(answer()));
  const result = await classifier().classify(parts, config);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://api.perplexity.ai/v1/decisions");
  expect(PERPLEXITY_DECISIONS_ENDPOINT).toBe(
    "https://api.perplexity.ai/v1/decisions",
  );
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("manual");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(headers.get("x-api-key")).toBeNull();
  expect(headers.get("content-type")).toBe("application/json");
  const body = JSON.parse(String(init?.body));
  expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
  expect(body.model).toBe("pplx-decider-v1.1-27b");
  expect(body.state).toEqual([{ id: "body", text: parts[0]?.text }]);
  expect(Object.keys(body.questions).sort()).toEqual([
    "category",
    "documentType",
    "receipt",
  ]);
  expect(body.questions.receipt.type).toBe("noul");
  expect(body.questions.documentType.type).toBe("choice");
  expect(body.questions.category.type).toBe("choice");
  expect(result).toEqual({
    status: "ok",
    output: JSON.stringify({
      status: "classified",
      isReceipt: true,
      category: "software",
    }),
    finish: "complete",
    usage: { input: 1200, output: 0, other: 0, source: "reported" },
  });
});

it("AI-CLASSIFIER-PROVIDER the configured model is sent and must be echoed", async () => {
  const fetch = mockFetch(() =>
    Response.json(answer(0.97, "pplx-decider-v1-27b")),
  );
  const result = await createPerplexityEmailClassifier(
    KEY,
    "pplx-decider-v1-27b",
    { timeoutMs: 1000 },
  ).classify(parts, { ...config, modelId: "pplx-decider-v1-27b" });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe(
    "pplx-decider-v1-27b",
  );
  expect(result.status).toBe("ok");
  // A different echoed model is a schema mismatch, not a decision.
  mockFetch(() => Response.json(answer(0.97, "clef")));
  const mismatch = await classifier().classify(parts, config);
  expect(mismatch).toEqual({
    status: "ok",
    output: JSON.stringify({ status: "needs-review", reason: "schema" }),
    finish: "complete",
    usage: null,
  });
});

it("AI-CLASSIFIER-PROVIDER negative and uncertain decisions use the shared Clef routing policy", async () => {
  for (const [noul, expected] of [
    [0.03, { status: "classified", isReceipt: false, category: "software" }],
    [0.5, { status: "needs-review", reason: "uncertain" }],
  ] as const) {
    mockFetch(() => Response.json(answer(noul)));
    const result = await classifier().classify(parts, config);
    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(JSON.parse(result.output)).toEqual(expected);
    vi.restoreAllMocks();
  }
});

it("AI-CLASSIFIER-PROVIDER malformed decision body becomes needs-review schema", async () => {
  for (const body of [
    { model: "pplx-decider-v1.1-27b", answers: {} },
    {
      ...answer(),
      answers: { ...answer().answers, receipt: { type: "noul", noul: 2 } },
    },
    {
      error: { message: "synthetic echo of user content", type: "x", code: 1 },
    },
  ]) {
    mockFetch(() => Response.json(body));
    expect(await classifier().classify(parts, config)).toEqual({
      status: "ok",
      output: JSON.stringify({ status: "needs-review", reason: "schema" }),
      finish: "complete",
      usage: null,
    });
    vi.restoreAllMocks();
  }
});

it("AI-CLASSIFIER-PROVIDER 429 returns rate-limit with Retry-After and does not retry", async () => {
  const fetch = mockFetch(
    () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
  );
  expect(await classifier().classify(parts, config)).toEqual({
    status: "failed",
    reason: "rate-limit",
    usage: null,
    retryAfterMs: 7000,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  mockFetch(() => new Response("", { status: 429 }));
  expect(await classifier().classify(parts, config)).toMatchObject({
    reason: "rate-limit",
    retryAfterMs: 30000,
  });
});

it("AI-CLASSIFIER-PROVIDER status codes map to typed failures without reading or logging provider bodies", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const secretBody = JSON.stringify({
    error: {
      message: "Synthetic invoice EUR 15 echoed by provider",
      type: "invalid_request",
      code: 400,
    },
  });
  for (const [status, reason] of [
    [401, "invalid-key"],
    [403, "invalid-key"],
    [400, "unsupported"],
    [404, "unsupported"],
    [405, "unsupported"],
    [413, "unsupported"],
    [500, "outage"],
    [502, "outage"],
    [503, "outage"],
    [504, "outage"],
    [302, "outage"],
  ] as const) {
    const spy = mockFetch(
      () =>
        new Response(status === 302 ? null : secretBody, {
          status,
          headers: {
            "x-request-id": "123e4567-e89b-42d3-a456-426614174000",
            ...(status === 302
              ? { Location: "https://attacker.example/v1/decisions" }
              : {}),
          },
        }),
    );
    expect(await classifier().classify(parts, config)).toEqual({
      status: "failed",
      reason,
      usage: null,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  }
  const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
  expect(logged).not.toContain("Synthetic invoice");
  expect(logged).not.toContain("attacker");
  expect(logged).not.toContain(KEY);
  expect(logged).toContain("123e4567-e89b-42d3-a456-426614174000");
  expect(logged).toContain('"status":503');
});

it("AI-CLASSIFIER-PROVIDER untrusted request ids are not logged", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mockFetch(
    () =>
      new Response("", {
        status: 500,
        headers: { "x-request-id": "Synthetic invoice EUR 15" },
      }),
  );
  await classifier().classify(parts, config);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("Synthetic invoice");
});

it("AI-CLASSIFIER-PROVIDER oversized or non-JSON success bodies fail closed as outage", async () => {
  const large = JSON.stringify({ ...answer(), padding: "x".repeat(70000) });
  for (const response of [
    () => new Response(large, { status: 200 }),
    () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(1024 * 1024) },
      }),
    () => new Response("not json", { status: 200 }),
  ]) {
    mockFetch(response);
    expect(await classifier().classify(parts, config)).toEqual({
      status: "failed",
      reason: "outage",
      usage: null,
    });
    vi.restoreAllMocks();
  }
});

it("AI-CLASSIFIER-PROVIDER network failure is outage; deadline and caller abort are timeout", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
  expect(await classifier().classify(parts, config)).toEqual({
    status: "failed",
    reason: "outage",
    usage: null,
  });
  vi.restoreAllMocks();
  // A fetch that never settles still stops at the configured deadline.
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () => new Promise<Response>(() => undefined),
  );
  const started = Date.now();
  expect(await classifier({ timeoutMs: 100 }).classify(parts, config)).toEqual({
    status: "failed",
    reason: "timeout",
    usage: null,
  });
  expect(Date.now() - started).toBeLessThan(5000);
  const controller = new AbortController();
  const pending = classifier({ timeoutMs: 5000 }).classify(
    parts,
    config,
    controller.signal,
  );
  controller.abort();
  expect(await pending).toEqual({
    status: "failed",
    reason: "timeout",
    usage: null,
  });
  // A body that stalls after headers also stops at the deadline.
  vi.restoreAllMocks();
  mockFetch(
    () =>
      new Response(
        new ReadableStream({ pull: () => new Promise(() => undefined) }),
        {
          status: 200,
        },
      ),
  );
  expect(await classifier({ timeoutMs: 100 }).classify(parts, config)).toEqual({
    status: "failed",
    reason: "timeout",
    usage: null,
  });
});

it("AI-CLASSIFIER-PROVIDER refuses mismatched destination, aborted caller or oversized input before any request", async () => {
  const fetch = mockFetch(() => Response.json(answer()));
  const aborted = new AbortController();
  aborted.abort();
  for (const [current, signal] of [
    [{ ...config, modelId: "@cf/cloudflare/clef" }, undefined],
    [{ ...config, destinationId: "cloudflare-clef" }, undefined],
    [{ ...config, maxInputBytes: 10 }, undefined],
    [config, aborted.signal],
  ] as const) {
    expect(await classifier().classify(parts, current, signal)).toEqual({
      status: "failed",
      reason: "unsupported",
      usage: null,
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});
