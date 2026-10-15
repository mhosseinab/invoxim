import type { ApprovedAiConfig } from "@invoxim/core";
import { afterEach, expect, it, vi } from "vitest";
import { aiDestinationSchema } from "../../../packages/adapters/src/ai/configuration";
import { createChatCompletionsExtractor } from "../../../packages/adapters/src/ai/http";

afterEach(() => vi.restoreAllMocks());
const destination = aiDestinationSchema.parse({
  id: "synthetic-stream-approved",
  endpoint: "https://stream-model.example.invalid/v1/chat/completions",
  configVersion: "synthetic-stream-v1",
  policyVersion: 1,
  noticeRefs: ["synthetic-no-live-terms"],
  timeoutMs: 1000,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  models: [
    {
      id: "synthetic-model",
      capabilities: {
        jsonSchema: false,
        jsonObject: false,
        outputLimit: "max_tokens",
        usage: true,
        idempotency: false,
      },
      pricing: {
        version: "synthetic-price-v1",
        approved: true,
        currency: "USD",
        source: "https://prices.example.invalid/synthetic",
        checkedAt: "2026-10-12T00:00:00Z",
        inputUsdMicrosPerMillion: "100",
        outputUsdMicrosPerMillion: "200",
        otherUsdMicrosPerMillion: "200",
      },
    },
  ],
});
function selectedModel() {
  const value = destination.models[0];
  if (!value) throw new Error("MISSING_SYNTHETIC_MODEL");
  return value;
}
const model = selectedModel();
const config: ApprovedAiConfig = {
  destinationId: destination.id,
  modelId: model.id,
  mode: "byok",
  settingsRevision: 1,
  consentId: "synthetic-consent",
  fingerprint: "synthetic-fingerprint",
  promptVersion: "invoice-extraction-v1",
  schemaVersion: 1,
  maxInputBytes: 8192,
  maxOutputBytes: 8192,
  maxOutputTokens: 256,
  maxAttempts: 1,
  reservationUnits: 131072,
};
const output = JSON.stringify({
  schemaVersion: 1,
  documentType: "non-purchase",
  records: [],
  warnings: [],
});
const envelope = new TextEncoder().encode(
  JSON.stringify({
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: output },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }),
);
function stream(
  chunks: readonly Uint8Array[],
  beforeRead?: (index: number) => void,
) {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        beforeRead?.(index);
        const value = chunks[index++];
        if (value === undefined) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body), cancelled: () => cancelled };
}
async function call(response: Response) {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const result = await createChatCompletionsExtractor(
    destination,
    model,
    "synthetic-never-production-key",
  ).extract([{ id: "body", text: "Synthetic unrelated newsletter" }], config, {
    id: "stream-attempt",
    repair: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe(destination.endpoint);
  return result;
}
it("AI stream rejects 33 cumulative empty chunks even with valid finite JSON below byte cap", async () => {
  const fixture = stream([
    ...Array.from({ length: 16 }, () => new Uint8Array()),
    envelope,
    ...Array.from({ length: 17 }, () => new Uint8Array()),
  ]);
  expect(await call(fixture.response)).toEqual({
    status: "failed",
    reason: "outage",
    usage: null,
  });
  expect(fixture.cancelled()).toBe(true);
});
it("AI stream rejects more than4096 nonempty chunks carrying finite valid JSON below byte cap", async () => {
  const bytes = new Uint8Array(4097);
  bytes.fill(32);
  bytes.set(envelope, 4097 - envelope.length);
  const fixture = stream(Array.from(bytes, (byte) => new Uint8Array([byte])));
  expect(await call(fixture.response)).toEqual({
    status: "failed",
    reason: "outage",
    usage: null,
  });
  expect(fixture.cancelled()).toBe(true);
});
it("AI stream preserves normal fragmented JSON and exact reported usage with32 empty chunks", async () => {
  const fixture = stream([
    ...Array.from({ length: 16 }, () => new Uint8Array()),
    envelope.slice(0, 23),
    envelope.slice(23, 67),
    envelope.slice(67),
    ...Array.from({ length: 16 }, () => new Uint8Array()),
  ]);
  expect(await call(fixture.response)).toEqual({
    status: "ok",
    output,
    finish: "complete",
    usage: { input: 5, output: 7, other: 0, source: "reported" },
  });
});
for (const phase of ["before-read", "after-data", "after-done"] as const) {
  it(`AI stream enforces elapsed destination timeout ${phase} even when immediate reads starve timer`, async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fixture = stream([envelope], (index) => {
      if (
        (phase === "after-data" && index === 0) ||
        (phase === "after-done" && index === 1)
      )
        now = 1001;
    });
    if (phase === "before-read")
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        now = 1001;
        return fixture.response;
      });
    const fetch =
      phase === "before-read"
        ? vi.mocked(globalThis.fetch)
        : vi.spyOn(globalThis, "fetch").mockResolvedValue(fixture.response);
    const result = await createChatCompletionsExtractor(
      destination,
      model,
      "synthetic-never-production-key",
    ).extract([{ id: "body", text: "Synthetic newsletter" }], config, {
      id: "elapsed-attempt",
      repair: false,
    });
    expect(result).toEqual({
      status: "failed",
      reason: "timeout",
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

it("AI stalled body whose cancel never settles fails as timeout within the destination deadline", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    call(new Response(body)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("AI read did not settle")),
        4000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  expect(result).toMatchObject({ status: "failed", reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(4000);
});
