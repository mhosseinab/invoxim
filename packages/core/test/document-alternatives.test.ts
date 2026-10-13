import { expect, it, vi } from "vitest";
import { createDocumentTextExtractor } from "../src/documents/extractor";
import type { MimePart } from "../src/documents/types";
import type { TenantContext } from "../src/tenant-context";

const bytes = (text: string) => new TextEncoder().encode(text);
const tenant = { userId: "synthetic", authority: "job" } as TenantContext;
function alternative(
  html: Uint8Array,
  plain = "Synthetic Shop\nReceipt date 2026-10-13\nPaid EUR 42.00",
  extra: Partial<MimePart> = {},
) {
  return {
    connectionId: "synthetic-mailbox",
    providerMessageId: "synthetic-message",
    root: {
      partId: "",
      mimeType: "multipart/alternative",
      children: [
        { partId: "plain", mimeType: "text/plain", bytes: bytes(plain) },
        { partId: "html", mimeType: "text/html", bytes: html, ...extra },
      ],
    },
  };
}
it("receipt facts in rich HTML are retained instead of a boilerplate plain alternative", async () => {
  const result = await createDocumentTextExtractor().extract(
    alternative(
      bytes(
        "<h1>Synthetic Shop</h1><p>Receipt date 2026-10-13</p><p>Paid EUR 42.00</p>",
      ),
      "Thank you. Your receipt is included.",
    ),
    { tenant },
  );
  expect(result.documents).toHaveLength(1);
  const document = result.documents[0];
  expect(document?.identity.partId).toBe("html");
  if (document?.status !== "ready")
    throw new Error("synthetic source unreadable");
  expect(document.textParts[0]?.text).toBe(
    "Synthetic Shop\nReceipt date 2026-10-13\nPaid EUR 42.00",
  );
  expect(result.ignoredPartIds).toEqual(["plain"]);
});
it.each([
  bytes(""),
  bytes("<script>Paid EUR 999</script><style>body{}</style>"),
  bytes("<div>   </div>"),
  new Uint8Array([255]),
  bytes("<script>not closed"),
])("unreadable or empty HTML falls back to ready plain text", async (html) => {
  const result = await createDocumentTextExtractor().extract(
    alternative(html),
    { tenant },
  );
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]?.identity.partId).toBe("plain");
  expect(result.documents[0]?.status).toBe("ready");
  expect(result.ignoredPartIds).toEqual(["html"]);
});
it("equivalent alternatives produce one body while independent PDF attachments remain separate and inert", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    const input = alternative(
      bytes(
        '<p>Synthetic Shop</p><p>Receipt date 2026-10-13</p><p>Paid EUR 42.00</p><img src="https://tracker.invalid"><script>fetch("https://tracker.invalid")</script>',
      ),
    );
    const pdf = vi.fn(async () => ({
      status: "ready" as const,
      pages: ["Independent invoice total EUR 10.00"],
      parserVersion: "synthetic-pdf",
    }));
    const result = await createDocumentTextExtractor({
      pdf: { extract: pdf },
    }).extract(
      {
        ...input,
        root: {
          partId: "mixed",
          mimeType: "multipart/mixed",
          children: [
            input.root,
            {
              partId: "invoice",
              mimeType: "application/pdf",
              disposition: "attachment",
              filename: "invoice.pdf",
              bytes: bytes("%PDF-synthetic"),
            },
          ],
        },
      },
      { tenant },
    );
    expect(result.documents.filter((doc) => doc.role === "body")).toHaveLength(
      1,
    );
    expect(
      result.documents.filter((doc) => doc.role === "attachment"),
    ).toHaveLength(1);
    expect(result.documents.map((doc) => doc.identity.partId)).toEqual([
      "html",
      "invoice",
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

it("legacy staged body preserves original plain part/hash/parser while new HTML is explicitly versioned", async () => {
  const input = alternative(
    bytes(
      "<p>Synthetic Shop</p><p>Receipt date 2026-10-13</p><p>Paid EUR 42.00</p>",
    ),
    "Thank you. Your receipt is included.",
  );
  const extractor = createDocumentTextExtractor();
  const legacy = await extractor.extract(input, {
    tenant,
    bodyAlternative: "legacy-plain",
  });
  const plain = input.root.children[0];
  if (!plain) throw new Error("missing synthetic plain source");
  const prior = await extractor.extract({ ...input, root: plain }, { tenant });
  expect(legacy.documents).toEqual(prior.documents);
  expect(legacy.documents[0]?.parserVersion).toBe("documents-v1");
  const current = await extractor.extract(input, { tenant });
  expect(current.documents[0]?.identity.partId).toBe("html");
  expect(current.documents[0]?.parserVersion).toBe("documents-v2");
});
it("HTML attachments retain prior parser identity and are not treated as alternatives", async () => {
  const result = await createDocumentTextExtractor().extract(
    {
      connectionId: "synthetic-mailbox",
      providerMessageId: "synthetic-message",
      root: {
        partId: "invoice",
        mimeType: "text/html",
        disposition: "attachment",
        filename: "invoice.html",
        bytes: bytes("<p>Paid EUR 42.00</p>"),
      },
    },
    { tenant },
  );
  expect(result.documents[0]?.role).toBe("attachment");
  expect(result.documents[0]?.parserVersion).toBe("documents-v1");
});
