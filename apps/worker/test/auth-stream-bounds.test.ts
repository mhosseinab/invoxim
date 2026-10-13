import { expect, it } from "vitest";
import { readAuthJson } from "../../../packages/adapters/src/auth/http";

function request(emptyChunks: number) {
  const bytes = new TextEncoder().encode('{"provider":"google"}');
  let offset = 0;
  return new Request("https://synthetic.example.test/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emptyChunks-- > 0) controller.enqueue(new Uint8Array());
        else if (offset < bytes.length)
          controller.enqueue(bytes.slice(offset, ++offset));
        else controller.close();
      },
    }),
  });
}
it("login request refuses excessive empty chunks below the byte cap", async () => {
  await expect(readAuthJson(request(33))).rejects.toMatchObject({
    status: 413,
    code: "request_too_large",
  });
});
it("login request accepts bounded empty and one-byte chunks", async () => {
  await expect(readAuthJson(request(32))).resolves.toEqual({
    provider: "google",
  });
});
