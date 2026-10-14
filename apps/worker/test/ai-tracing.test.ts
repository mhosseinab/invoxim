import type { AiResponse, InvoiceExtractor } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AiTracingBindings,
  langsmithConfiguration,
  traceChatExtractor,
} from "../../../packages/adapters/src/ai/tracing";

const response: AiResponse = {
  status: "ok",
  output: "PRIVATE RESPONSE",
  finish: "complete",
  usage: null,
};
const config = {
  destinationId: "abacus",
  modelId: "gpt-6-luna",
  mode: "hosted",
  settingsRevision: 1,
  consentId: "PRIVATE CONSENT",
  fingerprint: "PRIVATE FINGERPRINT",
  promptVersion: "v5",
  schemaVersion: 1,
  maxInputBytes: 24000,
  maxOutputBytes: 1000,
  maxOutputTokens: 100,
  maxAttempts: 1,
  reservationUnits: 1000,
} as const;
const parts = [{ id: "PRIVATE ID", text: "PRIVATE EMAIL" }];
const enabled = {
  AI_TRACING_ENABLED: "true",
  LANGSMITH_API_KEY: "synthetic-tracing-key",
};
afterEach(() => vi.restoreAllMocks());
function setup(bindings: AiTracingBindings = enabled, syntheticProbe = false) {
  const extract = vi
    .fn<InvoiceExtractor["extract"]>()
    .mockResolvedValue(response);
  return {
    extract,
    traced: traceChatExtractor({ extract }, langsmithConfiguration(bindings), {
      syntheticProbe,
    }),
  };
}
it("is disabled by default and invalid config cannot enable uploads", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const bindings of [
    {},
    { AI_TRACING_ENABLED: "TRUE", LANGSMITH_API_KEY: "key" },
    { AI_TRACING_ENABLED: "true" },
    { ...enabled, LANGSMITH_PROJECT: "bad\nproject" },
  ]) {
    const { traced } = setup(bindings);
    expect(
      await traced.extract(parts, config, {
        id: "PRIVATE ATTEMPT",
        repair: false,
      }),
    ).toBe(response);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("exports one completed redacted run, preserving missing usage", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  const { extract, traced } = setup();
  expect(
    await traced.extract(parts, config, {
      id: "PRIVATE ATTEMPT",
      repair: false,
    }),
  ).toBe(response);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://api.smith.langchain.com/runs");
  const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
  expect(body.inputs).toEqual({});
  expect(body.outputs).toEqual({});
  expect(body.extra.metadata).toMatchObject({
    status: "ok",
    usageAvailable: false,
    model: "gpt-6-luna",
  });
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(init?.redirect).toBe("error");
});
it("accepts successful inference despite trace outage without retrying either service", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("PRIVATE ERROR", { status: 503 }));
  const { extract, traced } = setup();
  expect(await traced.extract(parts, config, { id: "id", repair: false })).toBe(
    response,
  );
  expect(extract).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls.flat().join(" ")).not.toContain("PRIVATE");
});
it("content flag never exposes imports, but permits synthetic probe content", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  const bindings = { ...enabled, AI_TRACING_INCLUDE_CONTENT: "true" };
  await setup(bindings).traced.extract(parts, config, {
    id: "id",
    repair: false,
  });
  await setup(bindings, true).traced.extract(parts, config, {
    id: "id",
    repair: false,
  });
  const bodies = fetch.mock.calls.map(([, init]) =>
    JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)),
  );
  expect(bodies[0].inputs).toEqual({});
  expect(bodies[0].outputs).toEqual({});
  expect(bodies[1].inputs).toEqual({ parts: [{ text: "PRIVATE EMAIL" }] });
  expect(bodies[1].outputs).toEqual({ content: "PRIVATE RESPONSE" });
});

it("trace timeout aborts export and preserves the result", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise(() => undefined));
    const { traced, extract } = setup();
    const pending = traced.extract(parts, config, { id: "id", repair: false });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBe(response);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it("does not serialize thrown provider errors or change their identity", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  const error = new Error("PRIVATE PROVIDER KEY AND EMAIL");
  const extractor: InvoiceExtractor = {
    extract: vi.fn().mockRejectedValue(error),
  };
  const traced = traceChatExtractor(
    extractor,
    langsmithConfiguration(enabled),
    { syntheticProbe: false },
  );
  await expect(
    traced.extract(parts, config, { id: "id", repair: false }),
  ).rejects.toBe(error);
  const body = new TextDecoder().decode(
    fetch.mock.calls[0]?.[1]?.body as Uint8Array,
  );
  expect(body).not.toContain("PRIVATE");
  expect(JSON.parse(body).extra.metadata.status).toBe("exception");
});
it("scrubs credentials even from synthetic content", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  const extractor: InvoiceExtractor = {
    extract: vi.fn().mockResolvedValue({
      ...response,
      output: "synthetic-tracing-key synthetic-provider-key",
    }),
  };
  const traced = traceChatExtractor(
    extractor,
    langsmithConfiguration({ ...enabled, AI_TRACING_INCLUDE_CONTENT: "true" }),
    { syntheticProbe: true, providerKey: "synthetic-provider-key" },
  );
  await traced.extract(
    [{ id: "id", text: "synthetic-tracing-key synthetic-provider-key" }],
    config,
    { id: "id", repair: false },
  );
  const body = new TextDecoder().decode(
    fetch.mock.calls[0]?.[1]?.body as Uint8Array,
  );
  expect(body).not.toContain("synthetic-tracing-key");
  expect(body).not.toContain("synthetic-provider-key");
  expect(body).toContain("[redacted]");
});

it.each([
  "https://eu.api.smith.langchain.com",
  "https://traces.example.invalid/",
])(
  "exports only to the explicitly configured LangSmith host %s",
  async (host) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const { traced } = setup({ ...enabled, LANGSMITH_HOST: host });
    expect(
      await traced.extract(parts, config, { id: "id", repair: false }),
    ).toBe(response);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${new URL(host).origin}/runs`,
    );
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  },
);

it.each([
  "http://traces.example.invalid",
  "https://user:secret@traces.example.invalid",
  "https://traces.example.invalid/runs",
  "https://traces.example.invalid?key=secret",
  "https://traces.example.invalid#fragment",
  "https://traces.example.invalid/\n",
  "",
  "not-a-url",
])(
  "invalid tracing host disables telemetry without blocking inference: %s",
  async (host) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, "fetch");
    const { traced } = setup({ ...enabled, LANGSMITH_HOST: host });
    expect(
      await traced.extract(parts, config, { id: "id", repair: false }),
    ).toBe(response);
    expect(fetch).not.toHaveBeenCalled();
  },
);
