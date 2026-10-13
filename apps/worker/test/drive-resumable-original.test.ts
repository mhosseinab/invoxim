import { expect, it, vi } from "vitest";
import { createOriginalMailReader } from "../../../packages/adapters/src/documents/original-mail";

const header = new TextEncoder().encode(
  "From: synthetic@example.test\r\nSubject: Synthetic large original\r\nContent-Type: application/octet-stream\r\n\r\n",
);
const bytes = new Uint8Array(6 * 1024 * 1024 + header.length);
bytes.set(header);
bytes[header.length] = 255;
bytes[bytes.length - 1] = 128;
const configuration = {
  provider: "outlook" as const,
  accessToken: "synthetic-large-original-token",
  policy: { maxOriginalBytes: 4 * 1024 * 1024, deadlineMs: 1000 },
};
function fixture() {
  let calls = 0;
  return vi.fn<typeof fetch>(async () =>
    ++calls === 1
      ? Response.json({ id: "synthetic-large-message" })
      : new Response(bytes, { headers: { "Content-Type": "message/rfc822" } }),
  );
}
it("preserves default four-MiB original rejection when archive expansion is not selected", async () => {
  await expect(
    createOriginalMailReader(configuration, { fetcher: fixture() }).read({
      providerMessageId: "synthetic-large-message",
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ status: "unsupported", code: "byte_limit" });
});
it("supports an explicitly selected sixteen-MiB archive policy with exact >5MiB EML bytes", async () => {
  const result = await createOriginalMailReader(configuration, {
    fetcher: fixture(),
    archiveByteLimit: 16 * 1024 * 1024,
  }).read({
    providerMessageId: "synthetic-large-message",
    signal: new AbortController().signal,
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready")
    throw new Error("Synthetic expanded original unavailable");
  expect(result.bytes.length).toBe(bytes.length);
  expect(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(result.bytes)),
    ),
  ).toEqual(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
});
it.each([0, 16 * 1024 * 1024 + 1])(
  "rejects unsupported archive cap %s before any request",
  (archiveByteLimit) => {
    const fetcher = fixture();
    expect(() =>
      createOriginalMailReader(configuration, { fetcher, archiveByteLimit }),
    ).toThrow("INVALID_INPUT");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
