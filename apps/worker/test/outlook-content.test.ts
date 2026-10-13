import { DOCUMENT_LIMITS } from "@invoxim/core";
import { expect, it } from "vitest";
import { createOutlookContentReader } from "../../../packages/adapters/src/pipeline/outlook-content";

const messageId = "immutable+message/=";
function input(checkpoint: () => Promise<boolean> = async () => true) {
  return {
    connectionId: "synthetic-outlook",
    providerMessageId: messageId,
    signal: new AbortController().signal,
    checkpoint,
  };
}
function json(value: unknown) {
  return Response.json(value);
}
it("OUTLOOK-03 supplies inert body and exact decoded attachment bytes with immutable ID requests", async () => {
  const requests: {
    url: string;
    prefer: string | null;
    redirect: RequestInit["redirect"];
  }[] = [];
  const pdf = "%PDF-1.7\nSynthetic exact receipt\n%%EOF";
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async (url, init) => {
      requests.push({
        url: String(url),
        prefer: new Headers(init?.headers).get("prefer"),
        redirect: init?.redirect,
      });
      if (requests.length === 1)
        return json({
          id: messageId,
          body: {
            contentType: "html",
            content:
              '<p>Receipt EUR 12.00</p><img src="https://forbidden.invalid/pixel">',
          },
          hasAttachments: true,
        });
      return json({
        value: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "file+/=",
            name: "receipt.pdf",
            contentType: "application/pdf",
            size: pdf.length,
            isInline: false,
            contentBytes: btoa(pdf),
          },
        ],
      });
    },
  });
  const result = await reader.load(input());
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Positive Graph content fixture must be ready");
  expect(result.input.connectionId).toBe("synthetic-outlook");
  expect(result.input.providerMessageId).toBe(messageId);
  expect(result.input.root.children).toHaveLength(2);
  expect(new TextDecoder().decode(result.input.root.children?.[1]?.bytes)).toBe(
    pdf,
  );
  expect(result.input.root.children?.[1]?.mimeType).toBe("application/pdf");
  expect(requests).toHaveLength(2);
  expect(
    requests.every(
      (r) =>
        r.url.startsWith(
          "https://graph.microsoft.com/v1.0/me/messages/immutable%2Bmessage%2F%3D",
        ) &&
        r.prefer?.includes('IdType="ImmutableId"') &&
        r.redirect === "manual",
    ),
  ).toBe(true);
});
it("OUTLOOK-03 no accepted checkpoint performs no message content fetch", async () => {
  let calls = 0;
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () => {
      calls++;
      return json({});
    },
  });
  await expect(reader.load(input(async () => false))).rejects.toThrow(
    "CONTENT_AUTH_CHANGED",
  );
  expect(calls).toBe(0);
});
it("OUTLOOK-03 revoked authorization after body response stops the attachment request", async () => {
  let calls = 0,
    allowed = true;
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () => {
      calls++;
      allowed = false;
      return json({
        id: messageId,
        body: { contentType: "text", content: "Synthetic receipt" },
        hasAttachments: true,
      });
    },
  });
  await expect(reader.load(input(async () => allowed))).rejects.toThrow(
    "CONTENT_AUTH_CHANGED",
  );
  expect(calls).toBe(1);
});
it("OUTLOOK-03 reference attachment destinations never become network requests", async () => {
  const urls: string[] = [];
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async (url) => {
      urls.push(String(url));
      return urls.length === 1
        ? json({
            id: messageId,
            body: { contentType: "text", content: "Receipt" },
            hasAttachments: true,
          })
        : json({
            value: [
              {
                "@odata.type": "#microsoft.graph.referenceAttachment",
                id: "reference",
                name: "external.pdf",
                contentType: "application/pdf",
                size: 1,
                isInline: false,
                sourceUrl: "https://forbidden.invalid/invoice",
              },
            ],
          });
    },
  });
  const result = await reader.load(input());
  expect(urls).toHaveLength(2);
  expect(
    urls.every((url) => new URL(url).origin === "https://graph.microsoft.com"),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain("forbidden.invalid");
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error(
      "Reference must remain inert unsupported document evidence",
    );
  expect(result.input.root.children?.[1]?.mimeType).toBe(
    "application/vnd.microsoft.graph.reference-attachment",
  );
});
it("OUTLOOK-03 oversized declared attachment is rejected before retaining decoded bytes", async () => {
  let calls = 0;
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () =>
      ++calls === 1
        ? json({
            id: messageId,
            body: { contentType: "text", content: "Receipt" },
            hasAttachments: true,
          })
        : json({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "huge",
                name: "receipt.pdf",
                contentType: "application/pdf",
                size: DOCUMENT_LIMITS.bytes + 1,
                isInline: false,
                contentBytes: "",
              },
            ],
          }),
  });
  expect(await reader.load(input())).toEqual({
    status: "incomplete",
    code: "byte_limit",
  });
});

it("OUTLOOK-03 reads inline-only attachments even when Graph hasAttachments is false", async () => {
  let calls = 0;
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () =>
      ++calls === 1
        ? json({
            id: messageId,
            body: { contentType: "html", content: "<p>Receipt</p>" },
            hasAttachments: false,
          })
        : json({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "inline",
                name: "receipt.png",
                contentType: "image/png",
                size: 3,
                isInline: true,
                contentId: "receipt@synthetic",
                contentBytes: btoa("png"),
              },
            ],
          }),
  });
  const result = await reader.load(input());
  expect(calls).toBe(2);
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Inline fixture must be ready");
  expect(result.input.root.children?.[1]).toMatchObject({
    disposition: "inline",
    contentId: "receipt@synthetic",
    mimeType: "image/png",
  });
});

it("OUTLOOK-03 refuses an attachment whose declared size differs from decoded bytes", async () => {
  let calls = 0;
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () =>
      ++calls === 1
        ? json({
            id: messageId,
            body: { contentType: "text", content: "Receipt" },
            hasAttachments: true,
          })
        : json({
            value: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                id: "mismatch",
                name: "receipt.pdf",
                contentType: "application/pdf",
                size: 2,
                isInline: false,
                contentBytes: btoa("one"),
              },
            ],
          }),
  });
  expect(await reader.load(input())).toEqual({
    status: "unreadable",
    code: "invalid_mime",
  });
});

it("OUTLOOK-03 refuses a truncated attachment collection without following its next link", async () => {
  const urls: string[] = [];
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async (url) => {
      urls.push(String(url));
      return urls.length === 1
        ? json({
            id: messageId,
            body: { contentType: "text", content: "Receipt" },
            hasAttachments: true,
          })
        : json({
            value: [],
            "@odata.nextLink": "https://forbidden.invalid/next",
          });
    },
  });
  expect(await reader.load(input())).toEqual({
    status: "incomplete",
    code: "part_limit",
  });
  expect(urls).toHaveLength(2);
  expect(
    urls.every((url) => new URL(url).origin === "https://graph.microsoft.com"),
  ).toBe(true);
});

it("OUTLOOK-03 aborts an unresolved provider request when the import is canceled", async () => {
  const controller = new AbortController();
  let entered: (() => void) | undefined;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const reader = createOutlookContentReader("synthetic-token", {
    fetcher: async () => {
      entered?.();
      return new Promise<Response>(() => undefined);
    },
  });
  const result = reader.load({ ...input(), signal: controller.signal });
  await called;
  controller.abort();
  await expect(result).rejects.toThrow("CONTENT_AUTH_CHANGED");
});
