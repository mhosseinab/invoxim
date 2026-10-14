import { afterEach, expect, it, vi } from "vitest";
import { createGmailContentReader } from "../../../packages/adapters/src/pipeline/gmail-content";

afterEach(() => vi.restoreAllMocks());
it("reports only fixed multipart failure reasons, never source bytes or credentials", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url) === "https://gmail.googleapis.com/batch"
      ? new Response("PRIVATE SOURCE CONTENT", {
          headers: { "Content-Type": "multipart/mixed; boundary=synthetic" },
        })
      : Response.json({
          id: "message",
          payload: {
            partId: "root",
            mimeType: "multipart/mixed",
            parts: [0, 1].map((index) => ({
              partId: String(index),
              mimeType: "application/pdf",
              body: { size: 4, attachmentId: `attachment-${index}` },
            })),
          },
        }),
  );
  await expect(
    createGmailContentReader("PRIVATE ACCESS TOKEN", { fetcher }).load({
      connectionId: "mailbox",
      providerMessageId: "message",
      signal: new AbortController().signal,
      checkpoint: async () => true,
    }),
  ).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
  expect(warn).toHaveBeenCalledWith("gmail_attachment_batch_invalid", {
    reason: "opening-boundary",
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
});
