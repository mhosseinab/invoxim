import { EXTRACTION_PROMPT_VERSION } from "@invoxim/contracts";
import type { ApprovedAiConfig } from "@invoxim/core";
import { ChatOpenAICompletions } from "@langchain/openai";
import { afterEach, expect, it, vi } from "vitest";
import { aiDestinationSchema } from "../../../packages/adapters/src/ai/configuration";
import {
  chatReservationUnits,
  createChatCompletionsExtractor,
} from "../../../packages/adapters/src/ai/http";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const destination = aiDestinationSchema.parse({
  id: "synthetic-usage-provider",
  endpoint: "https://model.example.invalid/v1/chat/completions",
  configVersion: "synthetic-v1",
  policyVersion: 1,
  noticeRefs: ["synthetic-policy"],
  timeoutMs: 1000,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  models: [
    {
      id: "synthetic-model",
      capabilities: {
        jsonSchema: false,
        jsonObject: true,
        outputLimit: "max_tokens",
        usage: true,
        idempotency: false,
      },
      pricing: {
        version: "synthetic-price-v1",
        approved: true,
        currency: "USD",
        source: "https://prices.example.invalid/synthetic",
        checkedAt: "2026-10-13T00:00:00Z",
        inputUsdMicrosPerMillion: "1000000",
        outputUsdMicrosPerMillion: "2000000",
        otherUsdMicrosPerMillion: "2000000",
      },
    },
  ],
});
const model = destination.models[0];
if (!model) throw new Error("Synthetic model fixture missing");
const parts = [
  { id: "synthetic-part", text: "Synthetic non-purchase message" },
];
const output = JSON.stringify({
  schemaVersion: 1,
  documentType: "non-purchase",
  records: [],
  warnings: [],
});
const config: ApprovedAiConfig = {
  destinationId: destination.id,
  modelId: model.id,
  mode: "hosted",
  settingsRevision: 1,
  consentId: "synthetic-consent",
  fingerprint: "synthetic-fingerprint",
  promptVersion: EXTRACTION_PROMPT_VERSION,
  schemaVersion: 1,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  maxAttempts: 2,
  reservationUnits: chatReservationUnits(parts, model, 256),
};
const extractor = () =>
  createChatCompletionsExtractor(destination, model, "synthetic-private-key");
const choices = [
  {
    index: 0,
    finish_reason: "stop",
    message: { role: "assistant", content: output },
  },
];

it("LC-01 invokes LangChain once while preserving original response and absent usage", async () => {
  const invoke = vi.spyOn(ChatOpenAICompletions.prototype, "invoke");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ choices }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(
    await extractor().extract(parts, config, {
      id: "synthetic-attempt",
      repair: false,
    }),
  ).toEqual({ status: "ok", output, finish: "complete", usage: null });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("LC-02 ambient automatic tracing and verbose flags cannot export or log source content", async () => {
  for (const name of [
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_VERBOSE",
  ])
    vi.stubEnv(name, "true");
  vi.stubEnv("LANGSMITH_API_KEY", "synthetic-unapproved-tracing-key");
  vi.stubEnv("LC_OUTPUT_VERSION", "v1");
  const logs = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
  ];
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      choices,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );
  const result = await extractor().extract(parts, config, {
    id: "synthetic-attempt",
    repair: false,
  });
  expect(result.status).toBe("ok");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe(destination.endpoint);
  expect(logs.flatMap((log) => log.mock.calls.flat()).join(" ")).not.toContain(
    parts[0]?.text,
  );
  expect(logs.flatMap((log) => log.mock.calls.flat()).join(" ")).not.toContain(
    output,
  );
});
it.each([401, 403, 429, 503, 302])(
  "LC-03 HTTP %s cannot trigger SDK retries or destination fallback",
  async (status) => {
    const invoke = vi.spyOn(ChatOpenAICompletions.prototype, "invoke");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("synthetic-error", { status }));
    const result = await extractor().extract(parts, config, {
      id: "synthetic-attempt",
      repair: false,
    });
    expect(result.status).toBe("failed");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each(["gpt-5.6-luna", "custom-codex-model"])(
  "LC-04 approved %s stays on Chat Completions",
  async (id) => {
    const selected = { ...model, id };
    const target = { ...destination, models: [selected] };
    const approved = {
      ...config,
      modelId: id,
      reservationUnits: chatReservationUnits(
        parts,
        selected,
        config.maxOutputTokens,
      ),
    };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ choices }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await createChatCompletionsExtractor(
      target,
      selected,
      "synthetic-key",
    ).extract(parts, approved, { id: "synthetic-attempt", repair: false });
    expect(result.status).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(destination.endpoint);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe(id);
  },
);
