import { ArchiveServiceError } from "@invoxim/core";
import { describe, expect, it, vi } from "vitest";
import { createDriveArchiveTransport } from "../../../packages/adapters/src/drive/transport";

const token = "synthetic-workflow-drive-token";
const plan = {
  fileId: "synthetic-workflow-folder",
  workspaceMarker: "synthetic-workflow-marker",
  name: "Invoxim Receipts",
};
const folder = {
  id: plan.fileId,
  mimeType: "application/vnd.google-apps.folder",
  ownedByMe: true,
  trashed: false,
  appProperties: { workspace: plan.workspaceMarker, kind: "folder" },
};

describe("T18 archive workflow guarded transport boundaries", () => {
  it("denies ID generation before any remote request when the trusted workflow guard refuses", async () => {
    const http = vi.fn(async () =>
      Response.json({
        ids: ["synthetic-unused-id"],
        space: "drive",
        kind: "drive#generatedIds",
      }),
    );
    const authorize = vi.fn(async () => {
      throw new ArchiveServiceError("CONFLICT");
    });
    await expect(
      createDriveArchiveTransport(http, 10000, { authorize }).generateFileId(
        token,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });
  it("rechecks consent between the internal folder inspection and create request", async () => {
    let authorized = true;
    const authorize = vi.fn(async () => {
      if (!authorized) throw new ArchiveServiceError("CONFLICT");
    });
    const http = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        authorized = false;
        return new Response(null, { status: 404 });
      }
      return Response.json(folder);
    });
    await expect(
      createDriveArchiveTransport(http, 10000, { authorize }).ensureFolder(
        token,
        plan,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  });
});

describe("T18 workflow authorization cancellation", () => {
  it("does not dispatch if cancellation arrives while the authorization hook is awaiting", async () => {
    const controller = new AbortController();
    const http = vi.fn(async () => Response.json(folder));
    const authorize = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      createDriveArchiveTransport(http, 10000, {
        authorize,
        signal: controller.signal,
      }).ensureFolder(token, plan),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });
  it("bounds delayed authorization within the request deadline and never dispatches after late approval", async () => {
    let finish = () => {};
    const authorized = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const http = vi.fn(async () => Response.json(folder));
    const request = createDriveArchiveTransport(http, 100, {
      authorize: async () => authorized,
    }).ensureFolder(token, plan);
    await expect(request).rejects.toMatchObject({ code: "timeout" });
    finish();
    await authorized;
    await Promise.resolve();
    expect(http).not.toHaveBeenCalled();
  });
});
