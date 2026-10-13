import type { TenantContext } from "@invoxim/core";
import { expect, it, vi } from "vitest";
import { createGmailContentReader } from "../../../packages/adapters/src/pipeline/gmail-content";
import type { PipelineRepository } from "../../../packages/adapters/src/pipeline/repository";

it("T12 transient content fetches exact attachment identities without following redirects", async () => {
  const calls: string[] = [];
  const fetcher = vi.fn(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(request));
      expect(init?.redirect).toBe("manual");
      return Response.json(
        calls.length === 1
          ? {
              id: "message",
              payload: {
                partId: "",
                mimeType: "multipart/mixed",
                parts: [
                  {
                    partId: "body",
                    mimeType: "text/plain",
                    body: { size: 4, data: "dGVzdA" },
                  },
                  {
                    partId: "invoice",
                    mimeType: "application/pdf",
                    filename: "invoice.pdf",
                    body: { size: 4, attachmentId: "attachment" },
                  },
                ],
              },
            }
          : { size: 4, data: "JVBERg" },
      );
    },
  );
  const reader = createGmailContentReader("synthetic-token", { fetcher });
  const result = await reader.load({
    connectionId: "connection",
    providerMessageId: "message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result.status).toBe("ready");
  expect(calls[1]).toBe(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/message/attachments/attachment",
  );
});

it("T12 content stops before attachment network after authorization changes", async () => {
  let allowed = true;
  const fetcher = vi.fn(async () => {
    allowed = false;
    return Response.json({
      id: "message",
      payload: {
        partId: "",
        mimeType: "application/pdf",
        body: { size: 1, attachmentId: "attachment" },
      },
    });
  });
  const reader = createGmailContentReader("synthetic-token", { fetcher });
  await expect(
    reader.load({
      connectionId: "connection",
      providerMessageId: "message",
      signal: new AbortController().signal,
      checkpoint: async () => allowed,
    }),
  ).rejects.toThrow("CONTENT_AUTH_CHANGED");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("T12 content refuses oversized MIME before downloading attachments", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: "message",
      payload: {
        partId: "",
        mimeType: "application/pdf",
        body: { size: 4194305, attachmentId: "attachment" },
      },
    }),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "connection",
    providerMessageId: "message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result).toEqual({ status: "incomplete", code: "byte_limit" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("T12 malformed duplicate part identity stops before any attachment download", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: "message",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "same",
            mimeType: "application/pdf",
            body: { size: 1, attachmentId: "first" },
          },
          {
            partId: "same",
            mimeType: "application/pdf",
            body: { size: 1, attachmentId: "second" },
          },
        ],
      },
    }),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "connection",
    providerMessageId: "message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result).toEqual({ status: "unreadable", code: "invalid_mime" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("T12 inference refetches only its persisted attachment identity", async () => {
  const calls: string[] = [];
  const fetcher = vi.fn(async (request: RequestInfo | URL) => {
    calls.push(String(request));
    return Response.json(
      calls.length === 1
        ? {
            id: "message",
            payload: {
              partId: "",
              mimeType: "multipart/mixed",
              parts: [
                {
                  partId: "first",
                  mimeType: "application/pdf",
                  body: { size: 4, attachmentId: "first" },
                },
                {
                  partId: "second",
                  mimeType: "application/pdf",
                  body: { size: 4, attachmentId: "second" },
                },
              ],
            },
          }
        : { size: 4, data: "JVBERg" },
    );
  });
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "connection",
    providerMessageId: "message",
    partKey: "second",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result.status).toBe("ready");
  if (result.status === "ready")
    expect(result.input.root.partId).toBe("second");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("/attachments/second");
});

it("T12 oversized attachment fan-out has an explicit bounded result", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: "message",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        parts: Array.from({ length: 9 }, (_, index) => ({
          partId: String(index),
          mimeType: "application/pdf",
          body: { size: 1, attachmentId: `attachment${index}` },
        })),
      },
    }),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "connection",
    providerMessageId: "message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result).toEqual({ status: "incomplete", code: "part_limit" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("T12 over-limit encoded response cancels the stream with a safe typed failure", async () => {
  const canceled = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          },
          cancel() {
            canceled();
          },
        }),
      ),
  );
  await expect(
    createGmailContentReader("synthetic-token", { fetcher }).load({
      connectionId: "connection",
      providerMessageId: "message",
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).rejects.toThrow("CONTENT_BYTE_LIMIT");
  expect(canceled).toHaveBeenCalledTimes(1);
});

it("T12 staged legacy body remains stable and headroom shortage retries before paid inference", async () => {
  const { env } = await import("cloudflare:workers");
  const db = env.DB;
  const { createDocumentTextExtractor } = await import("@invoxim/core");
  const { createPipelineService } =
    await import("../../../packages/adapters/src/pipeline/service");
  const tenant = {
    userId: "headroom-tenant",
    authority: "job",
  } as TenantContext;
  const input = {
    connectionId: "connection",
    providerMessageId: "message",
    root: {
      partId: "alternative",
      mimeType: "multipart/alternative",
      children: [
        {
          partId: "body",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("synthetic receipt"),
        },
        {
          partId: "html",
          mimeType: "text/html",
          bytes: new TextEncoder().encode(
            "<p>New receipt HTML 15 EUR October 13, 2026</p>",
          ),
        },
      ],
    },
  };
  const documents = createDocumentTextExtractor();
  const parsed = await documents.extract(input, {
    tenant,
    bodyAlternative: "legacy-plain",
  });
  const document = parsed.documents[0];
  if (!document) throw new Error("missing synthetic document");
  const extractor = { extract: vi.fn() };
  const repository: PipelineRepository = {
    checkpoint: async () => true,
    load: async () => ({
      sourceId: "source",
      providerMessageId: "message",
      settingsRevision: 1,
      disclosureVersion: 1,
      stage: "infer",
      documentIndex: 0,
      extractionFingerprint: null,
      documents: [
        {
          id: "document",
          partKey: "body",
          contentHash: document.contentHash,
          mime: "text/plain",
          byteLength: 17,
          parseState: "ready",
          parserVersion: document.parserVersion,
        },
      ],
    }),
    stageDocuments: async () => "committed",
    advance: async () => "committed",
    cachedResult: async () => null,
    loadSnapshot: async () => null,
    commit: async () => "committed",
    fail: async () => "committed",
    failDocument: async () => "committed",
  };
  const service = createPipelineService(db, {
    repository,
    documents,
    content: {
      open: async () => ({ load: async () => ({ status: "ready", input }) }),
    },
    inference: {
      open: async () => ({
        config: {
          destinationId: "synthetic",
          modelId: "synthetic",
          mode: "hosted",
          settingsRevision: 1,
          consentId: "consent",
          fingerprint: "f".repeat(64),
          promptVersion: "invoice-extraction-v2",
          schemaVersion: 1,
          maxInputBytes: 1000,
          maxOutputBytes: 1000,
          maxOutputTokens: 100,
          maxAttempts: 1,
          reservationUnits: 1000,
        },
        extractor,
        pricing: new Map(),
      }),
    },
    budget: {
      dailyDocuments: 100,
      monthlyDocuments: 100,
      dailyUnits: 100000,
      monthlyUnits: 100000,
      globalDailyUsdMicros: "100000",
      globalMonthlyUsdMicros: "100000",
    },
    remainingStatements: () => 19,
  });
  const result = await service.run(
    {
      context: tenant,
      jobId: "job",
      connectionId: "connection",
      consentId: "consent",
      generation: 1,
      syncStateId: null,
      type: "source-extract",
      leaseId: "lease",
      fence: 1,
      expiresAt: Date.now() + 10000,
      attempt: 1,
    },
    { signal: new AbortController().signal, checkpoint: async () => true },
  );
  expect(result).toEqual({ kind: "retry", code: "transient" });
  expect(extractor.extract).not.toHaveBeenCalled();
});
