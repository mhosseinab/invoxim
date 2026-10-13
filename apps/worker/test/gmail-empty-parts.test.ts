import { expect, it, vi } from "vitest";
import { createGmailContentReader } from "../../../packages/adapters/src/pipeline/gmail-content";

it("Gmail accepts a valid text leaf with an explicitly empty parts array", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: "synthetic-message",
      payload: {
        partId: "",
        mimeType: "text/plain",
        parts: [],
        body: { size: 4, data: "dGVzdA" },
      },
    }),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "synthetic-connection",
    providerMessageId: "synthetic-message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Expected parsed Gmail input");
  expect(result.input.root.bytes).toEqual(new Uint8Array([116, 101, 115, 116]));
});

it("Gmail fetches an attachment leaf with an explicitly empty parts array", async () => {
  let calls = 0;
  const fetcher = vi.fn(async () =>
    Response.json(
      ++calls === 1
        ? {
            id: "synthetic-message",
            payload: {
              partId: "attachment-part",
              mimeType: "application/pdf",
              parts: [],
              body: { size: 4, attachmentId: "synthetic-attachment" },
            },
          }
        : { size: 4, data: "JVBERg" },
    ),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "synthetic-connection",
    providerMessageId: "synthetic-message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result.status).toBe("ready");
  expect(fetcher).toHaveBeenCalledTimes(2);
  if (result.status !== "ready") throw new Error("Expected attachment bytes");
  expect(result.input.root.bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
});

it.each([
  { parts: {}, body: { size: 4, data: "dGVzdA" } },
  {
    parts: [
      {
        partId: "child",
        mimeType: "text/plain",
        body: { size: 4, data: "dGVzdA" },
      },
    ],
    body: { size: 4, data: "dGVzdA" },
  },
])(
  "Gmail rejects malformed or nonempty child parts on a text leaf",
  async (leaf) => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: "synthetic-message",
        payload: { partId: "", mimeType: "text/plain", ...leaf },
      }),
    );
    const result = await createGmailContentReader("synthetic-token", {
      fetcher,
    }).load({
      connectionId: "synthetic-connection",
      providerMessageId: "synthetic-message",
      signal: new AbortController().signal,
      checkpoint: async () => true,
    });
    expect(result).toEqual({ status: "unreadable", code: "invalid_mime" });
  },
);

it("Gmail enforces byte bounds on an empty-parts attachment before download", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      id: "synthetic-message",
      payload: {
        partId: "",
        mimeType: "application/pdf",
        parts: [],
        body: { size: 4194305, attachmentId: "synthetic-attachment" },
      },
    }),
  );
  const result = await createGmailContentReader("synthetic-token", {
    fetcher,
  }).load({
    connectionId: "synthetic-connection",
    providerMessageId: "synthetic-message",
    signal: new AbortController().signal,
    checkpoint: async () => true,
  });
  expect(result).toEqual({ status: "incomplete", code: "byte_limit" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
