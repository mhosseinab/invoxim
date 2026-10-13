import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";
import { createGmailContentReader } from "../../../packages/adapters/src/pipeline/gmail-content";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function bodyStream(payload: unknown, size: number, empties = 0) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let offset = 0,
    empty = 0,
    pulls = 0,
    canceled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (empty++ < empties) {
          controller.enqueue(new Uint8Array(0));
          return;
        }
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + size);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream), state: () => ({ pulls, canceled }) };
}
for (const kind of ["discovery", "content"] as const) {
  describe(`${kind} streamed JSON bounds`, () => {
    const payload = (padding = "") =>
      kind === "discovery"
        ? { messages: [{ id: "synthetic-message" }], padding }
        : {
            id: "synthetic-message",
            payload: {
              partId: "0",
              mimeType: "text/plain",
              body: { size: 7, data: "cmVjZWlwdA" },
            },
            padding,
          };
    async function run(response: Response) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const signal = new AbortController().signal;
      if (kind === "discovery") {
        vi.stubGlobal("fetch", fetcher);
        return createGmailDiscovery("synthetic-token").list({
          range: { startMs: 1, cutoffMs: 100000, timezone: "UTC" },
          queryMode: "filtered",
          signal,
        });
      }
      return createGmailContentReader("synthetic-token", { fetcher }).load({
        connectionId: "synthetic-mailbox",
        providerMessageId: "synthetic-message",
        signal,
        checkpoint: async () => true,
      });
    }
    const error = {
      code: kind === "discovery" ? "UNAVAILABLE" : "CONTENT_UNAVAILABLE",
    };
    it.each(["empty", "tiny"])(
      "rejects excessive %s chunks and cancels body",
      async (mode) => {
        const stream = bodyStream(
          payload(mode === "tiny" ? "x".repeat(5000) : ""),
          mode === "tiny" ? 1 : 4096,
          mode === "empty" ? 33 : 0,
        );
        await expect(run(stream.response)).rejects.toMatchObject(error);
        expect(stream.state().canceled).toBe(true);
        expect(stream.state().pulls).toBeLessThanOrEqual(
          mode === "empty" ? 33 : 4097,
        );
      },
    );
    it("normal fragmentation preserves the parsed content", async () => {
      const stream = bodyStream(payload(), 7, 2);
      const result = await run(stream.response);
      if (kind === "discovery")
        expect(result).toEqual({ ids: ["synthetic-message"] });
      else
        expect(result).toMatchObject({
          status: "ready",
          input: { providerMessageId: "synthetic-message" },
        });
    });
    it("enforces elapsed deadline even on immediately resolved reads", async () => {
      const stream = bodyStream(payload(), 7);
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => (now += 3000));
      await expect(run(stream.response)).rejects.toMatchObject(error);
      expect(stream.state().canceled).toBe(true);
      expect(stream.state().pulls).toBeLessThanOrEqual(4);
    });
  });
}
