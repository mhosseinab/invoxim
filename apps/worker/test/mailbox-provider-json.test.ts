import { afterEach, expect, it, vi } from "vitest";
import { mailboxProviderJson } from "../../../packages/adapters/src/mailbox/provider-json";

afterEach(() => vi.restoreAllMocks());

it("mailbox provider JSON with a stalled body whose cancel never settles fails UNAVAILABLE within the 10 s deadline", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await expect(
    Promise.race([
      mailboxProviderJson("https://oauth2.googleapis.com/token", {
        method: "POST",
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mailbox read did not settle")),
          14000,
        );
      }),
    ]).finally(() => clearTimeout(timer)),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(Date.now() - started).toBeLessThan(14000);
}, 20000);
