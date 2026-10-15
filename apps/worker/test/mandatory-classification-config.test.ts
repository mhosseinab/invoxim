import { env } from "cloudflare:workers";
import type { JobLease, TenantContext } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import preset from "../../../config/ai.abacus.production.json";
import classification from "../../../config/ai.classification.production.json";
import type {
  AiBindings,
  AiConfiguration,
} from "../../../packages/adapters/src/ai/configuration";
import { aiConfiguration } from "../../../packages/adapters/src/ai/configuration";
import { createPipelineRuntime } from "../src/pipeline-runtime";

const run = vi.fn(async () => {
  throw new Error("NO_NETWORK_ALLOWED");
});
const bindings: AiBindings = {
  AI_ENABLED: "true",
  AI_REGISTRY_JSON: JSON.stringify(preset.registry),
  AI_BUDGET_JSON: JSON.stringify(preset.budget),
  CREDENTIAL_KEYRING: JSON.stringify({
    activeVersion: 1,
    keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  }),
  AI_CLASSIFICATION_JSON: JSON.stringify(classification),
  AI: { run },
};
it("enabled receipt processing requires configured enabled classification and its binding", () => {
  expect(aiConfiguration(bindings)?.classification).toEqual(classification);
  expect(run).not.toHaveBeenCalled();
});
it.each([
  { AI_CLASSIFICATION_JSON: "" },
  {
    AI_CLASSIFICATION_JSON: JSON.stringify({
      ...classification,
      enabled: false,
    }),
  },
  { AI_CLASSIFICATION_ENABLED: "false" },
  { AI: undefined },
  { AI_CLASSIFICATION_JSON: "invalid-json" },
  {
    AI_CLASSIFICATION_JSON: JSON.stringify({
      ...classification,
      model: "unsupported",
    }),
  },
])(
  "processing fails closed when mandatory classification is absent, disabled or invalid: %j",
  (override) => {
    expect(aiConfiguration({ ...bindings, ...override })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  },
);
it("the entire AI subsystem can still intentionally be disabled", () => {
  expect(aiConfiguration({ ...bindings, AI_ENABLED: "false" })).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it("production pipeline refuses missing or disabled classification before reading mailbox content", async () => {
  const configured = aiConfiguration(bindings);
  if (!configured?.classification)
    throw new Error("synthetic configuration missing");
  const { classification: classifier, ...withoutClassifier } = configured;
  const open = vi.fn(async () => {
    throw new Error("NO_CONTENT_ALLOWED");
  });
  const lease: JobLease = {
    context: { userId: "synthetic", authority: "job" } as TenantContext,
    jobId: "job",
    connectionId: "mailbox",
    consentId: "consent",
    generation: 1,
    syncStateId: null,
    type: "source-extract",
    leaseId: "lease",
    fence: 1,
    expiresAt: Date.now() + 30000,
    attempt: 1,
  };
  for (const ai of [
    // aiConfiguration never yields this shape; the runtime must still fail closed.
    withoutClassifier as AiConfiguration,
    { ...configured, classification: { ...classifier, enabled: false } },
  ]) {
    const runtime = createPipelineRuntime({
      db: env.DB,
      content: { open },
      ai,
      classificationBinding: bindings.AI,
      remainingStatements: () => 40,
    });
    expect(
      await runtime.run(lease, {
        signal: new AbortController().signal,
        checkpoint: async () => true,
      }),
    ).toEqual({ kind: "paused", code: "handler-unavailable" });
  }
  expect(open).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("omitting classification entirely fails closed", () => {
  const { AI_CLASSIFICATION_JSON: ignored, ...missing } = bindings;
  void ignored;
  expect(aiConfiguration(missing)).toBeNull();
});
