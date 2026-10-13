import { describe, expect, it, vi } from "vitest";
import { createDriveArchiveTransport } from "../../../packages/adapters/src/drive/transport";
import type { DriveOriginalPlan } from "../../../packages/adapters/src/drive/types";

const token = "synthetic-drive-token";
const bytes = new Uint8Array([0, 255, 10, 13, 128, 65]);
const hash = "a9b6ec3f62bd58b9bd73ebbc14f5bd2d53e0cc723d4cef38829efc2789890c76";
const plan: DriveOriginalPlan = {
  fileId: "synthetic-file-id",
  parentId: "synthetic-folder-id",
  workspaceMarker: "synthetic-workspace-marker",
  name: "receipt.pdf",
  mimeType: "application/pdf",
  size: bytes.length,
  sha256: hash,
};
function metadata(change: Record<string, unknown> = {}) {
  return {
    id: plan.fileId,
    mimeType: plan.mimeType,
    size: String(plan.size),
    parents: [plan.parentId],
    ownedByMe: true,
    trashed: false,
    sha256Checksum: hash,
    appProperties: {
      workspace: plan.workspaceMarker,
      kind: "original",
      sha256: hash,
    },
    ...change,
  };
}
function folder(change: Record<string, unknown> = {}) {
  return {
    id: plan.parentId,
    mimeType: "application/vnd.google-apps.folder",
    ownedByMe: true,
    trashed: false,
    appProperties: { workspace: plan.workspaceMarker, kind: "folder" },
    ...change,
  };
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function error(reason: string, status: number) {
  return json({ error: { errors: [{ reason }] } }, status);
}

describe("T18 bounded Drive transport: DRIVE-02/03/04 transport subset", () => {
  it("generates exactly one Drive file ID without archiving", async () => {
    const http = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(url.pathname).toBe("/drive/v3/files/generateIds");
      expect(url.searchParams.get("count")).toBe("1");
      expect(url.searchParams.get("space")).toBe("drive");
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      return json({
        ids: ["synthetic-generated-id"],
        space: "drive",
        kind: "drive#generatedIds",
      });
    });
    expect(await createDriveArchiveTransport(http).generateFileId(token)).toBe(
      "synthetic-generated-id",
    );
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("reconciles lost upload response using same planned ID and exact metadata", async () => {
    const http = vi.fn(async (request: Request) => {
      if (request.method === "POST") throw new Error("synthetic lost response");
      return json(request.url.includes(plan.parentId) ? folder() : metadata());
    });
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes),
    ).resolves.toBeUndefined();
    expect(
      http.mock.calls.filter(([request]) => request.method === "POST"),
    ).toHaveLength(1);
    expect(
      http.mock.calls.some(([request]) =>
        new URL(request.url).pathname.endsWith(`/files/${plan.fileId}`),
      ),
    ).toBe(true);
  });
  it("verifies 409 conflict instead of trusting a successful previous create", async () => {
    const http = vi.fn(async (request: Request) =>
      request.method === "POST"
        ? error("conflict", 409)
        : json(request.url.includes(plan.parentId) ? folder() : metadata()),
    );
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes),
    ).resolves.toBeUndefined();
  });
});

describe("T18 Drive transport adversarial boundaries", () => {
  it("preserves binary multipart bytes and never converts or chooses a new ID", async () => {
    const http = vi.fn(async (request: Request) => {
      if (request.method === "GET") return json(folder());
      const url = new URL(request.url);
      expect(url.pathname).toBe("/upload/drive/v3/files");
      expect(url.searchParams.get("uploadType")).toBe("multipart");
      expect(request.redirect).toBe("manual");
      const contentType = request.headers.get("content-type") ?? "";
      const boundary = contentType.split("boundary=")[1];
      expect(boundary).toBeTruthy();
      const body = new Uint8Array(await request.arrayBuffer());
      const text = new TextDecoder("latin1").decode(body);
      expect(text).toContain(`"id":"${plan.fileId}"`);
      expect(text).toContain(`"mimeType":"application/pdf"`);
      const prefix = new TextEncoder().encode(
        "Content-Type: application/pdf\r\n\r\n",
      );
      const offset =
        text.indexOf("Content-Type: application/pdf\r\n\r\n") + prefix.length;
      expect([...body.slice(offset, offset + bytes.length)]).toEqual([
        ...bytes,
      ]);
      expect(new TextDecoder().decode(body.slice(offset + bytes.length))).toBe(
        `\r\n--${boundary}--\r\n`,
      );
      return json(metadata());
    });
    await createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes);
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("copies exact .eml MIME bytes without rendering into PDF", async () => {
    const eml = new TextEncoder().encode(
      "From: synthetic@example.test\r\nContent-Type: text/plain\r\n\r\nOriginal synthetic receipt\r\n",
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", eml));
    const sha256 = [...digest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const emlPlan = {
      ...plan,
      name: "receipt.eml",
      mimeType: "message/rfc822" as const,
      size: eml.length,
      sha256,
    };
    const http = vi.fn(async (request: Request) => {
      if (request.method === "GET") return json(folder());
      const body = new TextDecoder().decode(await request.arrayBuffer());
      expect(body).toContain(new TextDecoder().decode(eml));
      expect(body).toContain('"mimeType":"message/rfc822"');
      expect(body).not.toContain("application/pdf");
      return json(
        metadata({
          mimeType: emlPlan.mimeType,
          size: String(eml.length),
          sha256Checksum: sha256,
          appProperties: {
            workspace: plan.workspaceMarker,
            kind: "original",
            sha256,
          },
        }),
      );
    });
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, emlPlan, eml),
    ).resolves.toBeUndefined();
  });
  it.each([
    ["id", { id: "another-id" }],
    ["MIME", { mimeType: "application/vnd.google-apps.document" }],
    ["size", { size: "7" }],
    ["parent", { parents: ["another-folder"] }],
    ["owner", { ownedByMe: false }],
    ["trashed", { trashed: true }],
    [
      "workspace",
      {
        appProperties: {
          workspace: "other-workspace-marker",
          kind: "original",
          sha256: hash,
        },
      },
    ],
    [
      "stable hash",
      {
        appProperties: {
          workspace: plan.workspaceMarker,
          kind: "original",
          sha256: "0".repeat(64),
        },
      },
    ],
    ["binary checksum", { sha256Checksum: "0".repeat(64) }],
    ["missing checksum", { sha256Checksum: undefined }],
  ])("rejects existing 409 %s mismatch", async (_label, change) => {
    const http = vi.fn(async (request: Request) =>
      request.method === "POST"
        ? error("conflict", 409)
        : json(
            request.url.includes(plan.parentId) ? folder() : metadata(change),
          ),
    );
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes),
    ).rejects.toMatchObject({ code: "metadata_mismatch" });
    expect(
      http.mock.calls.filter(([request]) => request.method === "POST"),
    ).toHaveLength(1);
  });
  it("rejects a one-byte change before any network request", async () => {
    const http = vi.fn(async () => json(metadata()));
    const changed = new Uint8Array(bytes);
    changed[1] = 254;
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, plan, changed),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(http).not.toHaveBeenCalled();
  });
  it("copies caller-owned bytes before awaiting folder metadata", async () => {
    const input = new Uint8Array(bytes);
    const http = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        input.fill(0);
        return json(folder());
      }
      const body = new Uint8Array(await request.arrayBuffer());
      expect(body.some((byte) => byte === 255)).toBe(true);
      return json(metadata());
    });
    await createDriveArchiveTransport(http).uploadOriginal(token, plan, input);
  });
  it.each([
    ["quota", 403, "storageQuotaExceeded", "quota_exceeded"],
    ["revoked", 401, "authError", "reconnect_required"],
    ["permission", 403, "insufficientFilePermissions", "permission_denied"],
    ["rate limit", 429, "rateLimitExceeded", "rate_limited"],
  ])(
    "classifies %s without blind upload retries",
    async (_label, status, reason, code) => {
      const http = vi.fn(async (request: Request) =>
        request.method === "POST" ? error(reason, status) : json(folder()),
      );
      await expect(
        createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes),
      ).rejects.toMatchObject({ code });
      expect(http).toHaveBeenCalledTimes(2);
    },
  );
  it("does not recreate a missing archive folder during upload", async () => {
    const http = vi.fn(async () => json({}, 404));
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(token, plan, bytes),
    ).rejects.toMatchObject({ code: "folder_missing" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("uses persisted folder ID when creation response is lost", async () => {
    let calls = 0;
    const http = vi.fn(async (request: Request) => {
      calls++;
      if (calls === 1) return json({}, 404);
      if (request.method === "POST") {
        const payload = (await request.json()) as {
          id: string;
          mimeType: string;
        };
        expect(payload.id).toBe(plan.parentId);
        expect(payload.mimeType).toBe("application/vnd.google-apps.folder");
        throw new Error("synthetic lost folder response");
      }
      return json(folder());
    });
    await expect(
      createDriveArchiveTransport(http).ensureFolder(token, {
        fileId: plan.parentId,
        workspaceMarker: plan.workspaceMarker,
        name: "Receipts",
      }),
    ).resolves.toBeUndefined();
    expect(http).toHaveBeenCalledTimes(3);
  });
  it("validates an existing app-created folder without creating duplicates", async () => {
    const http = vi.fn(async () => json(folder()));
    await createDriveArchiveTransport(http).ensureFolder(token, {
      fileId: plan.parentId,
      workspaceMarker: plan.workspaceMarker,
      name: "Receipts",
    });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("refuses an unrelated existing folder", async () => {
    const http = vi.fn(async () =>
      json(
        folder({
          appProperties: {
            workspace: "another-workspace-marker",
            kind: "folder",
          },
        }),
      ),
    );
    await expect(
      createDriveArchiveTransport(http).ensureFolder(token, {
        fileId: plan.parentId,
        workspaceMarker: plan.workspaceMarker,
        name: "Receipts",
      }),
    ).rejects.toMatchObject({ code: "metadata_mismatch" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("reports missing original without claiming archived success", async () => {
    const http = vi.fn(async () => json({}, 404));
    expect(
      await createDriveArchiveTransport(http).inspectOriginal(token, plan),
    ).toBe(false);
  });
  it("does not follow provider redirects or Location upload destinations", async () => {
    const http = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.invalid/upload" },
      });
    });
    await expect(
      createDriveArchiveTransport(http).generateFileId(token),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0]?.[0].url).toMatch(
      /^https:\/\/www.googleapis.com\/drive\/v3\//,
    );
  });
  it.each([
    [
      "advertised length",
      () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": "16385",
          },
        }),
    ],
    [
      "stream size",
      () =>
        new Response(" ".repeat(16385), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "malformed JSON",
      () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
    ],
  ])("rejects %s bounded-response violations", async (_label, response) => {
    await expect(
      createDriveArchiveTransport(async () => response()).generateFileId(token),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("times out a hanging request even if its transport ignores AbortSignal", async () => {
    await expect(
      createDriveArchiveTransport(
        () => new Promise<Response>(() => {}),
        100,
      ).generateFileId(token),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("times out a hanging response body read", async () => {
    const http = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ids":['));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    await expect(
      createDriveArchiveTransport(http, 100).generateFileId(token),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it.each([
    { fileId: "../../escape" },
    { parentId: "https://attacker.invalid/path" },
    { name: "../receipt.pdf" },
    { name: "receipt\n.pdf" },
    { mimeType: "application/vnd.google-apps.document" },
    { size: 5 * 1024 * 1024 + 1 },
    { workspaceMarker: "alice@example.test" },
  ])("rejects invalid plan %j before outbound calls", async (change) => {
    const http = vi.fn(async () => json(metadata()));
    await expect(
      createDriveArchiveTransport(http).uploadOriginal(
        token,
        { ...plan, ...change } as DriveOriginalPlan,
        bytes,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(http).not.toHaveBeenCalled();
  });
});

describe("T18 independent review: late HTTP settlement cleanup", () => {
  function deferredResponse() {
    let settle: (response: Response) => void = () => {};
    const promise = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const canceled = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"ids":["synthetic-late-id"]}'),
          );
        },
        cancel() {
          canceled();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    if (!response.body) throw new Error("synthetic response body missing");
    const read = vi.spyOn(response.body, "getReader");
    return { promise, settle, response, canceled, read };
  }
  async function releaseLate(late: ReturnType<typeof deferredResponse>) {
    late.settle(late.response);
    await late.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  it("cancels an unread response that arrives after the typed timeout", async () => {
    const late = deferredResponse();
    const http = vi.fn(() => late.promise);
    await expect(
      createDriveArchiveTransport(http, 100).generateFileId(token),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(late.canceled).not.toHaveBeenCalled();
    await releaseLate(late);
    expect(late.canceled).toHaveBeenCalledTimes(1);
    expect(late.read).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("reconciles only the planned ID and cancels a late upload response without another POST", async () => {
    const late = deferredResponse();
    const http = vi.fn(async (request: Request) => {
      if (request.method === "POST") return late.promise;
      return json(request.url.includes(plan.parentId) ? folder() : metadata());
    });
    await expect(
      createDriveArchiveTransport(http, 100).uploadOriginal(token, plan, bytes),
    ).resolves.toBeUndefined();
    const posts = http.mock.calls.filter(
      ([request]) => request.method === "POST",
    );
    expect(posts).toHaveLength(1);
    const uploadRequest = posts[0]?.[0];
    if (!uploadRequest) throw new Error("synthetic upload request missing");
    const uploadBody = new TextDecoder().decode(
      await uploadRequest.arrayBuffer(),
    );
    expect(uploadBody).toContain(`"id":"${plan.fileId}"`);
    const reads = http.mock.calls.filter(
      ([request]) => request.method === "GET",
    );
    expect(reads.map(([request]) => new URL(request.url).pathname)).toEqual([
      `/drive/v3/files/${plan.parentId}`,
      `/drive/v3/files/${plan.fileId}`,
    ]);
    await releaseLate(late);
    expect(late.canceled).toHaveBeenCalledTimes(1);
    expect(late.read).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe("T18 Drive JSON response chunk budgets", () => {
  const generated = {
    ids: ["synthetic-chunk-id"],
    space: "drive",
    kind: "drive#generatedIds",
  };
  function fragmented(empty: number, oneByte: boolean) {
    const canceled = vi.fn();
    const value = new TextEncoder().encode(
      JSON.stringify(generated) + (oneByte ? " ".repeat(4097) : ""),
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (empty > 0) {
            empty--;
            controller.enqueue(new Uint8Array(0));
            return;
          }
          if (offset >= value.length) {
            controller.close();
            return;
          }
          const width = oneByte ? 1 : 7;
          controller.enqueue(value.subarray(offset, offset + width));
          offset += width;
        },
        cancel() {
          canceled();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    return { response, canceled };
  }
  it("rejects a finite response with 33 empty chunks and cancels unread data", async () => {
    const { response, canceled } = fragmented(33, false);
    await expect(
      createDriveArchiveTransport(async () => response).generateFileId(token),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(canceled).toHaveBeenCalledTimes(1);
  });
  it("rejects over 4096 tiny chunks even when total JSON bytes fit", async () => {
    const { response, canceled } = fragmented(0, true);
    await expect(
      createDriveArchiveTransport(async () => response).generateFileId(token),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(canceled).toHaveBeenCalledTimes(1);
  });
  it("checks elapsed deadline while finite immediate reads starve timer delivery", async () => {
    const start = Date.now();
    const value = new TextEncoder().encode(JSON.stringify(generated));
    let offset = 0;
    let delivered = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= value.length) {
            controller.close();
            return;
          }
          controller.enqueue(value.subarray(offset, offset + 17));
          offset += 17;
          delivered++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => start + delivered * 60);
    try {
      await expect(
        createDriveArchiveTransport(async () => response, 100).generateFileId(
          token,
        ),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      clock.mockRestore();
    }
  });
  it("accepts normally fragmented JSON with 32 bounded empty chunks", async () => {
    const { response } = fragmented(32, false);
    await expect(
      createDriveArchiveTransport(async () => response).generateFileId(token),
    ).resolves.toBe("synthetic-chunk-id");
  });
});
