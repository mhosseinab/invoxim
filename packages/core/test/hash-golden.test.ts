import { expect, it } from "vitest";
import { aiRunIdentityKey } from "../src/ai/engine";
import type { AiCheckpoint, ApprovedAiConfig } from "../src/ai/types";
import { createDocumentTextExtractor } from "../src/documents/extractor";
import type { DocumentContext } from "../src/documents/types";
import type { TenantContext } from "../src/tenant-context";

/**
 * SW-1 / ext#15: core keeps one sha256Hex. These goldens pin the stored
 * contentHash and run-identity digests so consolidating the three copies
 * (extractor.hashHex, archive.digest, engine inline) cannot change bytes.
 */
const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
const context = { tenant, inputMode: "direct-model" } as DocumentContext;

const goldenPdfContentHash =
  "a01de6a6a86f3503b20a3a18ba0e5cca91f7ab089e7ab0d2e559297331b7294b";
const goldenHelloContentHash =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const goldenRunIdentity =
  "238b3f78ce48294fd043965e4c3267247333072485f4babe3d07c0732a57e1a1";

it("document contentHash stays byte-identical", async () => {
  const result = await createDocumentTextExtractor({
    pdf: {
      extract: async () => ({
        status: "ready" as const,
        pages: ["synthetic"],
        parserVersion: "synthetic",
      }),
    },
  }).extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "synthetic-message",
      root: {
        partId: "invoice",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-synthetic"),
      },
    },
    context,
  );
  const doc = result.documents[0];
  if (doc?.status !== "ready") throw new Error("not ready");
  expect(doc.contentHash).toBe(goldenPdfContentHash);
});

it("plain-attachment contentHash stays byte-identical", async () => {
  const result = await createDocumentTextExtractor().extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "synthetic-message",
      root: {
        partId: "note",
        mimeType: "text/plain",
        filename: "note",
        disposition: "attachment",
        bytes: new TextEncoder().encode("hello"),
      },
    },
    context,
  );
  const doc = result.documents[0];
  if (doc?.status !== "ready") throw new Error("not ready");
  expect(doc.contentHash).toBe(goldenHelloContentHash);
});

it("aiRunIdentityKey stays byte-identical", async () => {
  const config: ApprovedAiConfig = {
    destinationId: "approved",
    modelId: "synthetic",
    mode: "byok",
    settingsRevision: 1,
    consentId: "c1",
    fingerprint:
      "7312195c90c33616f52e1709d521134b98fe20607cb1a2f08ac14a750dae9389",
    promptVersion: "1",
    schemaVersion: 1,
    maxInputBytes: 1000,
    maxOutputBytes: 1000,
    maxOutputTokens: 100,
    maxAttempts: 2,
    reservationUnits: 1000,
  };
  const checkpoint: AiCheckpoint = {
    tenant: { userId: "user-1", authority: "job" } as TenantContext,
    identity: {
      documentId: "doc-1",
      contentHash: goldenHelloContentHash,
      extractionVersion: "1",
    },
    config,
  };
  expect(await aiRunIdentityKey(checkpoint)).toBe(goldenRunIdentity);
});
