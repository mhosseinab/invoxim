import { afterEach, expect, it, vi } from "vitest";
import { createOutlookGraphTransport } from "../../../packages/adapters/src/discovery/outlook-transport";
import { createGmailAuthorization } from "../../../packages/adapters/src/mailbox/gmail";
import { createOutlookAuthorization } from "../../../packages/adapters/src/mailbox/outlook";

afterEach(() => vi.restoreAllMocks());
function response(
  value: unknown,
  empty: number,
  width: number,
  tick?: () => void,
) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        tick?.();
        if (empty-- > 0) controller.enqueue(new Uint8Array());
        else if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + width));
          offset += width;
        } else controller.close();
      },
    }),
  );
}
for (const provider of ["gmail", "outlook", "graph"] as const) {
  for (const mode of ["empty", "tiny", "elapsed", "normal"] as const) {
    it(`${provider} bounds ${mode} response fragmentation independently of bytes`, async () => {
      let clock = 1700000000000;
      if (mode === "elapsed")
        vi.spyOn(Date, "now").mockImplementation(() => clock);
      const empty = mode === "empty" ? 33 : mode === "elapsed" ? 0 : 32;
      const width = mode === "tiny" ? 1 : 7;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const value =
          provider === "graph"
            ? { value: [], padding: "x".repeat(4200) }
            : String(url).includes("token")
              ? {
                  access_token: "synthetic-access-token",
                  token_type: "Bearer",
                  expires_in: 3600,
                  padding: "x".repeat(4200),
                }
              : {
                  sub: "synthetic-subject",
                  email: "synthetic@example.test",
                  email_verified: true,
                };
        return response(
          value,
          empty,
          width,
          mode === "elapsed"
            ? () => {
                clock += 600;
              }
            : undefined,
        );
      });
      const task =
        provider === "graph"
          ? createOutlookGraphTransport("synthetic-access-token")(
              "https://graph.microsoft.com/v1.0/me/mailFolders",
              new AbortController().signal,
              "collection",
            )
          : (provider === "gmail"
              ? createGmailAuthorization
              : createOutlookAuthorization)({
              clientId: "synthetic-client",
              clientSecret: "synthetic-client-secret",
            }).refresh(
              {
                accessToken: "synthetic-old",
                refreshToken: "synthetic-refresh",
                expiresAt: 1,
              },
              {
                subject:
                  provider === "gmail"
                    ? "synthetic-subject"
                    : "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0|synthetic-subject",
                address: "synthetic@example.test",
              },
            );
      if (mode === "normal") {
        if (provider === "graph")
          await expect(task).resolves.toMatchObject({ value: [] });
        else
          await expect(task).resolves.toMatchObject({
            accessToken: "synthetic-access-token",
          });
      } else await expect(task).rejects.toMatchObject({ code: "UNAVAILABLE" });
    });
  }
}
