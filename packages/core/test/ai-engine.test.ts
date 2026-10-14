import { expect, it } from "vitest";
import {
  type ClassificationUsageStore,
  createClassificationEngine,
  EMAIL_CLASSIFICATION_VERSION,
  type EmailClassifier,
} from "../src/ai/classification";
import { createInferenceEngine } from "../src/ai/engine";
import type {
  AiUsageStore,
  ApprovedAiConfig,
  InvoiceExtractor,
} from "../src/ai/types";
import type { TenantContext } from "../src/tenant-context";

const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
const config: ApprovedAiConfig = {
  destinationId: "approved",
  modelId: "synthetic",
  mode: "byok",
  settingsRevision: 1,
  consentId: "c1",
  fingerprint: "cfg1",
  promptVersion: "1",
  schemaVersion: 1,
  maxInputBytes: 1000,
  maxOutputBytes: 1000,
  maxOutputTokens: 100,
  maxAttempts: 2,
  reservationUnits: 1000,
};
const identity = {
  documentId: "d1",
  contentHash: "hash1",
  extractionVersion: "1",
};
it("AI-06 retains uncertain timeout reservation and refuses replay network", async () => {
  let reserved = false;
  let calls = 0;
  let uncertain = false;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      if (reserved) return "existing";
      reserved = true;
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_input, value) {
      uncertain = value.state === "uncertain";
    },
    async complete() {
      return false;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      calls++;
      return { status: "failed", reason: "timeout", usage: null };
    },
  };
  const engine = createInferenceEngine({ extractor, store });
  expect(
    await engine.extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "timeout" });
  expect(uncertain).toBe(true);
  expect(
    await engine.extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "in-progress" });
  expect(calls).toBe(1);
});
it("AI-01 allows exactly one structural repair at same selected destination", async () => {
  let calls = 0;
  const destinations: string[] = [];
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle() {},
    async complete() {
      return true;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract(_parts, current) {
      calls++;
      destinations.push(current.destinationId);
      return {
        status: "ok",
        output: "invalid JSON",
        finish: "complete",
        usage: { input: 1, output: 1, other: 0, source: "reported" },
      };
    },
  };
  const result = await createInferenceEngine({ extractor, store }).extract(
    tenant,
    identity,
    [{ id: "body", text: "synthetic" }],
    config,
  );
  expect(result).toEqual({ status: "needs-review", reason: "schema" });
  expect(calls).toBe(2);
  expect(destinations).toEqual(["approved", "approved"]);
});

it("AI-03 cached tenant-version extraction replay never invokes provider", async () => {
  let calls = 0;
  const cached = {
    status: "accepted",
    documentType: "non-purchase",
    records: [],
    warnings: [],
  } as const;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "completed", result: { ...cached, warnings: [] } };
    },
    async reserve() {
      throw new Error("RESERVATION_FOR_CACHED_RESULT");
    },
    async authorize() {
      return false;
    },
    async settle() {},
    async complete() {
      return false;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      calls++;
      return { status: "failed", reason: "outage", usage: null };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual(cached);
  expect(calls).toBe(0);
});
it("AI-06 unknown usage prevents even a structural repair", async () => {
  let calls = 0;
  const settlements: string[] = [];
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      settlements.push(value.state);
    },
    async complete() {
      return true;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      calls++;
      return {
        status: "ok",
        output: "invalid",
        finish: "complete",
        usage: null,
      };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "schema" });
  expect(calls).toBe(1);
  expect(settlements).toEqual(["uncertain"]);
});
it("ONBOARD-10 stale consent makes no reservation or network request", async () => {
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "stale" };
    },
    async reserve() {
      throw new Error("STALE_RESERVATION");
    },
    async authorize() {
      return false;
    },
    async settle() {},
    async complete() {
      return false;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      throw new Error("STALE_NETWORK");
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "settings-changed" });
});
it("AI-05 unavailable reservation performs no provider call", async () => {
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "budget";
    },
    async authorize() {
      throw new Error("UNRESERVED_AUTHORIZATION");
    },
    async settle() {},
    async complete() {
      return false;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      throw new Error("UNRESERVED_NETWORK");
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "budget" });
});

it("AI-05 preserves reported over-budget usage and blocks acceptance", async () => {
  let reported = 0;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      reported = value.usage?.output ?? 0;
    },
    async complete() {
      return true;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      return {
        status: "ok",
        output: JSON.stringify({
          schemaVersion: 1,
          documentType: "non-purchase",
          records: [],
          warnings: [],
        }),
        finish: "complete",
        usage: { input: 1, output: 1500, other: 0, source: "reported" },
      };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "budget" });
  expect(reported).toBe(1500);
});

it("AI-04 preserves long cooldown sentinel for durable manual pause", async () => {
  let cooldown = 0;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      cooldown = value.retryAfterMs ?? 0;
    },
    async complete() {
      return true;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      return {
        status: "failed",
        reason: "rate-limit",
        usage: null,
        retryAfterMs: Number.MAX_SAFE_INTEGER,
      };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "rate-limit" });
  expect(cooldown).toBe(Number.MAX_SAFE_INTEGER);
});

it("K3 classification settle forwards rate-limit retryAfterMs like extraction", async () => {
  let settled: unknown;
  const store: ClassificationUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      settled = value;
    },
    async complete() {
      return true;
    },
  };
  const classifier: EmailClassifier = {
    async classify() {
      return {
        status: "failed",
        reason: "rate-limit",
        usage: null,
        retryAfterMs: 90_000,
      };
    },
  };
  const classificationConfig: ApprovedAiConfig = {
    ...config,
    promptVersion: EMAIL_CLASSIFICATION_VERSION,
    maxAttempts: 1,
  };
  expect(
    await createClassificationEngine({ classifier, store }).classify(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      classificationConfig,
    ),
  ).toEqual({ status: "needs-review", reason: "rate-limit" });
  expect(settled).toEqual({
    state: "uncertain",
    usage: null,
    retryAfterMs: 90_000,
  });
});

it("AI-05 retains excessive individually safe usage whose exact combined total exceeds Number precision", async () => {
  let settled: unknown;
  const usage = {
    input: Number.MAX_SAFE_INTEGER,
    output: Number.MAX_SAFE_INTEGER,
    other: 1,
    source: "reported",
  } as const;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      settled = value;
    },
    async complete() {
      throw new Error("OVER_BUDGET_COMPLETION");
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      return {
        status: "ok",
        output: JSON.stringify({
          schemaVersion: 1,
          documentType: "non-purchase",
          records: [],
          warnings: [],
        }),
        finish: "complete",
        usage,
      };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "budget" });
  expect(settled).toEqual({ state: "uncertain", usage });
});
it("AI-06 estimated usage remains conservative and prevents structural repair", async () => {
  let calls = 0;
  let settled: unknown;
  const usage = { input: 1, output: 1, other: 1, source: "estimated" } as const;
  const store: AiUsageStore = {
    async checkpoint() {
      return { status: "ready" };
    },
    async reserve() {
      return "reserved";
    },
    async authorize() {
      return true;
    },
    async settle(_attempt, value) {
      settled = value;
    },
    async complete() {
      return true;
    },
  };
  const extractor: InvoiceExtractor = {
    async extract() {
      calls++;
      return { status: "ok", output: "invalid", finish: "complete", usage };
    },
  };
  expect(
    await createInferenceEngine({ extractor, store }).extract(
      tenant,
      identity,
      [{ id: "body", text: "synthetic" }],
      config,
    ),
  ).toEqual({ status: "needs-review", reason: "schema" });
  expect(calls).toBe(1);
  expect(settled).toEqual({ state: "uncertain", usage });
});
