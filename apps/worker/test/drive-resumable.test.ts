import { expect, it, vi } from "vitest";
import { createDriveResumableTransport } from "../../../packages/adapters/src/drive/resumable";
import { createDriveArchiveTransport } from "../../../packages/adapters/src/drive/transport";
import type { DriveOriginalPlan } from "../../../packages/adapters/src/drive/types";

const token = "synthetic-resumable-drive-token";
const sessionUrl =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-session-handle";
const bytes = new Uint8Array(6 * 1024 * 1024 + 1);
bytes[0] = 255;
bytes[bytes.length - 1] = 128;
it("inspects an existing ready folder without recreating a remotely deleted destination", async () => {
  const http = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe(
      "/drive/v3/files/synthetic-resumable-folder",
    );
    return new Response(null, { status: 404 });
  });
  const transport = createDriveArchiveTransport(http);
  await expect(
    transport.inspectFolder(token, {
      fileId: "synthetic-resumable-folder",
      workspaceMarker: "synthetic-resumable-workspace",
      name: "unused",
    }),
  ).rejects.toMatchObject({ code: "folder_missing" });
  expect(http).toHaveBeenCalledTimes(1);
});
async function plan(): Promise<DriveOriginalPlan> {
  const sha256 = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return {
    fileId: "synthetic-resumable-file",
    parentId: "synthetic-resumable-folder",
    workspaceMarker: "synthetic-resumable-workspace",
    name: "receipt.eml",
    mimeType: "message/rfc822",
    size: bytes.length,
    sha256,
  };
}
it("starts a >5MiB resumable upload with the exact persisted ID and validates the fixed session location", async () => {
  const original = await plan();
  const http = vi.fn(async (request: Request) => {
    expect(request.method).toBe("POST");
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/upload/drive/v3/files",
    );
    expect(url.searchParams.get("uploadType")).toBe("resumable");
    expect(request.headers.get("X-Upload-Content-Length")).toBe(
      String(bytes.length),
    );
    expect(request.headers.get("X-Upload-Content-Type")).toBe("message/rfc822");
    expect(await request.json()).toMatchObject({
      id: original.fileId,
      mimeType: original.mimeType,
      parents: [original.parentId],
      appProperties: {
        workspace: original.workspaceMarker,
        sha256: original.sha256,
        kind: "original",
      },
    });
    return new Response(null, {
      status: 200,
      headers: { Location: sessionUrl },
    });
  });
  await expect(
    createDriveResumableTransport(http).initiate(token, original),
  ).resolves.toBe(sessionUrl);
  expect(http).toHaveBeenCalledTimes(1);
});
it("uploads one exact four-MiB chunk and advances only by the acknowledged Range", async () => {
  const original = await plan();
  const http = vi.fn(async (request: Request) => {
    expect(request.url).toBe(sessionUrl);
    expect(request.method).toBe("PUT");
    expect(request.headers.get("Content-Range")).toBe(
      `bytes 0-4194303/${bytes.length}`,
    );
    const chunk = await request.arrayBuffer();
    expect(chunk.byteLength).toBe(4 * 1024 * 1024);
    expect(
      new Uint8Array(await crypto.subtle.digest("SHA-256", chunk)),
    ).toEqual(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          bytes.subarray(0, 4 * 1024 * 1024),
        ),
      ),
    );
    return new Response(null, {
      status: 308,
      headers: { Range: "bytes=0-4194303" },
    });
  });
  await expect(
    createDriveResumableTransport(http).uploadChunk(
      token,
      original,
      sessionUrl,
      bytes,
      0,
    ),
  ).resolves.toEqual({ status: "incomplete", uploadedBytes: 4 * 1024 * 1024 });
  expect(http).toHaveBeenCalledTimes(1);
});
it("probes a completed session then verifies exact planned-file metadata before claiming success", async () => {
  const original = await plan();
  const http = vi.fn(async (request: Request) => {
    if (request.method === "PUT") {
      expect(request.headers.get("Content-Range")).toBe(
        `bytes */${bytes.length}`,
      );
      expect((await request.arrayBuffer()).byteLength).toBe(0);
      return Response.json({ id: "synthetic-untrusted-completion-body" });
    }
    expect(new URL(request.url).pathname).toBe(
      `/drive/v3/files/${original.fileId}`,
    );
    return Response.json({
      id: original.fileId,
      mimeType: original.mimeType,
      size: String(original.size),
      parents: [original.parentId],
      ownedByMe: true,
      trashed: false,
      sha256Checksum: original.sha256,
      appProperties: {
        workspace: original.workspaceMarker,
        kind: "original",
        sha256: original.sha256,
      },
    });
  });
  await expect(
    createDriveResumableTransport(http).probe(token, original, sessionUrl),
  ).resolves.toEqual({ status: "complete" });
  expect(http.mock.calls.map(([request]) => request.method)).toEqual([
    "PUT",
    "GET",
  ]);
});

it("probes the same session after an empty 503 chunk response and uses only its acknowledged bytes", async () => {
  const original = await plan();
  let calls = 0;
  const http = vi.fn(async (request: Request) => {
    expect(request.url).toBe(sessionUrl);
    if (++calls === 1) return new Response(null, { status: 503 });
    expect(request.headers.get("Content-Range")).toBe(
      `bytes */${bytes.length}`,
    );
    expect((await request.arrayBuffer()).byteLength).toBe(0);
    return new Response(null, {
      status: 308,
      headers: { Range: "bytes=0-2097151" },
    });
  });
  await expect(
    createDriveResumableTransport(http).uploadChunk(
      token,
      original,
      sessionUrl,
      bytes,
      0,
    ),
  ).resolves.toEqual({ status: "incomplete", uploadedBytes: 2 * 1024 * 1024 });
  expect(http).toHaveBeenCalledTimes(2);
});
