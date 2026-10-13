import { afterEach, expect, it, vi } from "vitest";
import { createOutlookGraphDiscovery } from "../../../packages/adapters/src/discovery/outlook";

afterEach(() => vi.restoreAllMocks());
it("untrusted continuation cannot send a mailbox credential outside Graph", async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    calls.push(String(request));
    return Response.json({ value: [] });
  });
  await expect(
    createOutlookGraphDiscovery("synthetic-access-token").folders({
      nextLink: "https://evil.example/steal",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(calls).toEqual([]);
});
const signal = () => new AbortController().signal;
const graph = "https://graph.microsoft.com/v1.0/me";
const folderId = "AQMkArchive==";
const id = "AAkImmutable+/==";
const next = `${graph}/mailfolders('${folderId}')/messages/delta?$skiptoken=a%2fb%2B%252f%3D`;
const delta = `${graph}/mailfolders('${folderId}')/messages/delta?$deltatoken=unchanged%2Fopaque%2Bvalue%3D`;
const folder = (
  id: string,
  parentFolderId = "Root==",
  children = 0,
  displayName = "Archive",
) => ({
  id,
  parentFolderId,
  childFolderCount: children,
  displayName,
  isHidden: false,
});
function replies(...values: (unknown | Response)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    calls.push({ url: String(request), init });
    const value = values.shift();
    if (value === undefined) throw new Error("Synthetic unexpected request");
    return value instanceof Response ? value : Response.json(value);
  });
  return calls;
}
it("root pagination, nested children and Archive remain bounded explicit inventory pages", async () => {
  const link = `${graph}/mailFolders?$top=5&$skip=5`;
  const calls = replies(
    { value: [folder(folderId, "Root==", 1)], "@odata.nextLink": link },
    { value: [folder("Other==")] },
    { value: [folder("Child==", folderId, 0, "Receipts")] },
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  const first = await adapter.folders({ signal: signal() });
  expect(first).toEqual({
    folders: [folder(folderId, "Root==", 1)],
    nextLink: link,
  });
  expect(Object.hasOwn(first, "complete")).toBe(false);
  if (!first.nextLink) throw new Error("Synthetic folder cursor missing");
  expect(
    (await adapter.folders({ nextLink: first.nextLink, signal: signal() }))
      .folders[0]?.id,
  ).toBe("Other==");
  expect(
    (await adapter.folders({ parentFolderId: folderId, signal: signal() }))
      .folders[0]?.parentFolderId,
  ).toBe(folderId);
  expect(calls[1]?.url).toBe(link);
  expect(calls[2]?.url).toContain(
    `/mailFolders/${encodeURIComponent(folderId)}/childFolders?`,
  );
  expect(
    new URL(calls[0]?.url ?? "").searchParams.get("includeHiddenFolders"),
  ).toBe("true");
  for (const call of calls)
    expect(new Headers(call.init?.headers).get("Prefer")).toContain(
      'IdType="ImmutableId"',
    );
});
it("locale-independent well-known folders resolve exclusions without display-name guessing", async () => {
  const calls = replies(
    folder("RealJunk==", "Root==", 0, "Unerwünscht"),
    folder("CustomFolder==", "Root==", 0, "Junk Email"),
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  expect((await adapter.folder("junkemail", signal())).id).toBe("RealJunk==");
  expect((await adapter.folder("CustomFolder==", signal())).id).toBe(
    "CustomFolder==",
  );
  expect(calls[0]?.url).toContain("/mailFolders/junkemail?");
});
it("backfill uses exact UTC inclusive-start exclusive-cutoff filter without search/order/delta cap", async () => {
  const range = {
    startMs: Date.parse("2026-03-28T23:00:00.500Z"),
    cutoffMs: Date.parse("2026-03-29T22:00:00.750Z"),
    timezone: "Europe/Vienna",
  };
  const link = `${graph}/mailFolders/${encodeURIComponent(folderId)}/messages?$skiptoken=opaque%2B%2F%3D`;
  const calls = replies(
    { value: [{ id }, { id }], "@odata.nextLink": link },
    { value: [] },
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  expect(
    await adapter.listFolder({ folderId, range, signal: signal() }),
  ).toEqual({ ids: [id], nextLink: link });
  const url = new URL(calls[0]?.url ?? "");
  expect(url.searchParams.get("$filter")).toBe(
    "receivedDateTime ge 2026-03-28T23:00:00.500Z and receivedDateTime lt 2026-03-29T22:00:00.750Z",
  );
  expect(url.searchParams.get("$select")).toBe("id");
  expect(url.searchParams.has("$search")).toBe(false);
  expect(url.searchParams.has("$orderby")).toBe(false);
  await adapter.listFolder({
    folderId,
    range,
    nextLink: link,
    signal: signal(),
  });
  expect(calls[1]?.url).toBe(link);
});
it("delta baseline is unfiltered; opaque next and delta links survive restart byte-for-byte", async () => {
  const calls = replies(
    { value: [{ id }], "@odata.nextLink": next },
    { value: [], "@odata.deltaLink": delta },
    { value: [{ id }], "@odata.deltaLink": delta },
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  expect(await adapter.deltaFolder({ folderId, signal: signal() })).toEqual({
    ids: [id],
    folderRemovedIds: [],
    nextLink: next,
  });
  const initial = new URL(calls[0]?.url ?? "");
  expect(initial.searchParams.get("$filter")).toBeNull();
  expect(initial.searchParams.get("changeType")).toBeNull();
  expect(initial.searchParams.get("$search")).toBeNull();
  const second = await adapter.deltaFolder({
    folderId,
    continuationLink: next,
    signal: signal(),
  });
  expect(second).toEqual({ ids: [], folderRemovedIds: [], deltaLink: delta });
  if (!second.deltaLink) throw new Error("Synthetic delta cursor missing");
  // Fresh invocation obtains its URL only from the caller's persisted state.
  await createOutlookGraphDiscovery("synthetic-graph-access").deltaFolder({
    folderId,
    continuationLink: second.deltaLink,
    signal: signal(),
  });
  expect(calls.map(({ url }) => url).slice(1)).toEqual([next, delta]);
});
it("folder removal and another folder add retain the same immutable ID without global deletion", async () => {
  const other = "OtherFolder==";
  const calls = replies(
    {
      value: [{ id, "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": delta,
    },
    {
      value: [{ id }],
      "@odata.deltaLink": `${graph}/mailFolders/${encodeURIComponent(other)}/messages/delta?$deltatoken=other`,
    },
    {
      id,
      parentFolderId: other,
      receivedDateTime: "2026-03-29T12:00:00Z",
      isDraft: false,
    },
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  const removed = await adapter.deltaFolder({
    folderId,
    continuationLink: delta,
    signal: signal(),
  });
  expect(removed.folderRemovedIds).toEqual([id]);
  expect(Object.hasOwn(removed, "deletedIds")).toBe(false);
  expect(
    (await adapter.deltaFolder({ folderId: other, signal: signal() })).ids,
  ).toEqual([id]);
  const current = await adapter.metadata(id, signal());
  expect(current).toMatchObject({
    id,
    parentFolderId: other,
    available: true,
    excluded: false,
    candidate: "unknown",
  });
  expect(calls[2]?.url).toContain(`/messages/${encodeURIComponent(id)}?`);
});
it("ambiguous replay of removal and addition preserves both facts for coordinator resolution", async () => {
  replies({
    value: [{ id }, { id, "@removed": {} }, { id }],
    "@odata.deltaLink": delta,
  });
  expect(
    await createOutlookGraphDiscovery("synthetic-graph-access").deltaFolder({
      folderId,
      signal: signal(),
    }),
  ).toEqual({ ids: [id], folderRemovedIds: [id], deltaLink: delta });
});
it.each([
  "https://graph.microsoft.com.evil.example/v1.0/me/mailFolders?$skip=1",
  "http://graph.microsoft.com/v1.0/me/mailFolders?$skip=1",
  "https://synthetic-password@graph.microsoft.com/v1.0/me/mailFolders?$skip=1",
  "https://graph.microsoft.com:444/v1.0/me/mailFolders?$skip=1",
  "https://graph.microsoft.com/beta/me/mailFolders?$skip=1",
  "https://graph.microsoft.com/v1.0/users/other/mailFolders?$skip=1",
  "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=1#fragment",
  "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=1&$select=body",
  "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=1&$skip=2",
  "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=1&$top=50",
  "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=1&$expand=messages",
  "",
])(
  "malformed or unauthorized continuation %s is refused before credential transmission",
  async (nextLink) => {
    const calls = replies({ value: [] });
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").folders({
        nextLink,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  },
);
it("same-origin continuations cannot jump folders or resource kinds", async () => {
  const calls = replies({ value: [] });
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  await expect(
    adapter.deltaFolder({
      folderId: "OtherFolder==",
      continuationLink: next,
      signal: signal(),
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(
    adapter.folders({
      parentFolderId: folderId,
      nextLink: next,
      signal: signal(),
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(calls).toHaveLength(0);
});
it.each([
  { value: [], "@odata.nextLink": next, "@odata.deltaLink": delta },
  { value: [] },
  { value: [], "@odata.deltaLink": "" },
  { value: [], "@odata.deltaLink": next },
  { value: [], "@odata.nextLink": delta },
  { value: [], "@odata.nextLink": "https://evil.example/delta" },
])(
  "delta response cannot fabricate completion or malformed cursor %j",
  async (body) => {
    replies(body);
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").deltaFolder({
        folderId,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  },
);
it.each(["folders", "delta", "messages"] as const)(
  "ignored five-row limit on %s fails without partial page/cursor",
  async (kind) => {
    const values = Array.from({ length: 6 }, (_, i) =>
      kind === "folders" ? folder(`Folder${i}==`) : { id: `Message${i}==` },
    );
    replies({ value: values, "@odata.deltaLink": delta });
    const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
    const operation =
      kind === "folders"
        ? adapter.folders({ signal: signal() })
        : kind === "delta"
          ? adapter.deltaFolder({ folderId, signal: signal() })
          : adapter.listFolder({
              folderId,
              range: { startMs: 1, cutoffMs: 2, timezone: "UTC" },
              signal: signal(),
            });
    await expect(operation).rejects.toMatchObject({ code: "UNAVAILABLE" });
  },
);
it("metadata identity must match requested ID; drafts excluded and unknown remains honest", async () => {
  const calls = replies(
    {
      id: "Other==",
      parentFolderId: folderId,
      receivedDateTime: "2026-03-29T12:00:00Z",
      isDraft: false,
    },
    {
      id,
      parentFolderId: folderId,
      receivedDateTime: "2026-03-29T12:00:00.123Z",
      isDraft: true,
    },
    new Response(null, { status: 404 }),
  );
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  await expect(adapter.metadata(id, signal())).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(await adapter.metadata(id, signal())).toEqual({
    id,
    parentFolderId: folderId,
    receivedAtMs: Date.parse("2026-03-29T12:00:00.123Z"),
    available: true,
    excluded: true,
    candidate: "unknown",
  });
  expect(await adapter.metadata(id, signal())).toEqual({
    id,
    parentFolderId: null,
    receivedAtMs: 0,
    available: false,
    excluded: true,
    candidate: "unknown",
  });
  for (const call of calls)
    expect(new URL(call.url).searchParams.get("$select")).toBe(
      "id,parentFolderId,receivedDateTime,isDraft",
    );
});
it.each([410, 400, 404])(
  "delta reset %s is controlled and never follows Location or overwrites old cursor",
  async (status) => {
    const calls = replies(
      new Response(
        JSON.stringify({
          error: {
            code: "syncStateNotFound",
            message: "synthetic-private-provider-detail",
          },
        }),
        { status, headers: { Location: "https://evil.example/reset" } },
      ),
    );
    const input = { folderId, continuationLink: delta, signal: signal() };
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").deltaFolder(input),
    ).rejects.toMatchObject({
      code: "HISTORY_EXPIRED",
      message: "HISTORY_EXPIRED",
    });
    expect(input.continuationLink).toBe(delta);
    expect(calls).toHaveLength(1);
  },
);
it.each([401, 403])(
  "provider auth/tenant-policy refusal %s cannot trigger fallback",
  async (status) => {
    const calls = replies(new Response(null, { status }));
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").folders({
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(calls).toHaveLength(1);
  },
);
it.each([429, 503])(
  "provider retry-after %s is preserved as controlled rate limit",
  async (status) => {
    replies(new Response(null, { status, headers: { "retry-after": "120" } }));
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").folders({
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 120000 });
  },
);
it.each([
  "redirect",
  "invalid-json",
  "advertised-too-large",
  "stream-too-large",
])("transport refuses %s with redacted typed error", async (kind) => {
  const response =
    kind === "redirect"
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example" },
        })
      : kind === "invalid-json"
        ? new Response("not-json")
        : kind === "advertised-too-large"
          ? new Response("{}", { headers: { "content-length": "65537" } })
          : new Response("x".repeat(65537));
  const calls = replies(response);
  await expect(
    createOutlookGraphDiscovery("synthetic-graph-access").folders({
      signal: signal(),
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.redirect).toBe("manual");
});
it("per-invocation request cap and abort prevent further transport; no cursor work on invalid range", async () => {
  const calls = replies(...Array.from({ length: 12 }, () => ({ value: [] })));
  const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
  for (let i = 0; i < 12; i++) await adapter.folders({ signal: signal() });
  await expect(adapter.folders({ signal: signal() })).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(calls).toHaveLength(12);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    createOutlookGraphDiscovery("synthetic-graph-access").folders({
      signal: aborted.signal,
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(
    createOutlookGraphDiscovery("synthetic-graph-access").listFolder({
      folderId,
      range: { startMs: 2, cutoffMs: 1, timezone: "UTC" },
      signal: signal(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_RANGE" });
  expect(calls).toHaveLength(12);
});
it("external abort ends a pending body read even if synthetic stream does not honor fetch signal", async () => {
  const controller = new AbortController();
  replies(
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
          setTimeout(() => controller.abort(), 10);
        },
      }),
    ),
  );
  await expect(
    createOutlookGraphDiscovery("synthetic-graph-access").folders({
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it.each([401, 403, 429, 503, 410, 404, 302, 200])(
  "early response %s aborts owned transport and cancels unconsumed noncooperative error body",
  async (status) => {
    let canceled = false;
    let transportSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
        return new Promise<void>(() => {});
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      transportSignal = init?.signal;
      return new Response(body, {
        status,
        headers: status === 200 ? { "content-length": "65537" } : {},
      });
    });
    const caller = new AbortController();
    const adapter = createOutlookGraphDiscovery("synthetic-graph-access");
    const operation =
      status === 410
        ? adapter.deltaFolder({
            folderId,
            continuationLink: delta,
            signal: caller.signal,
          })
        : status === 404
          ? adapter.metadata(id, caller.signal)
          : adapter.folders({ signal: caller.signal });
    if (status === 404)
      await expect(operation).resolves.toMatchObject({ available: false });
    else
      await expect(operation).rejects.toMatchObject({
        code:
          status === 410
            ? "HISTORY_EXPIRED"
            : status === 401 || status === 403
              ? "AUTH_REQUIRED"
              : status === 429 || status === 503
                ? "RATE_LIMITED"
                : "UNAVAILABLE",
      });
    expect(transportSignal?.aborted).toBe(true);
    expect(canceled).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  },
);
it("successful response also releases the owned request signal without canceling the caller", async () => {
  let transportSignal: AbortSignal | null | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    transportSignal = init?.signal;
    return Response.json({ value: [] });
  });
  const caller = new AbortController();
  expect(
    await createOutlookGraphDiscovery("synthetic-graph-access").folders({
      signal: caller.signal,
    }),
  ).toEqual({ folders: [] });
  expect(transportSignal?.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
});
it.each([`${delta}&$skiptoken=`, `${next}&$deltatoken=`])(
  "empty second paging key cannot disguise contradictory continuation %s",
  async (continuationLink) => {
    const calls = replies({ value: [], "@odata.deltaLink": delta });
    await expect(
      createOutlookGraphDiscovery("synthetic-graph-access").deltaFolder({
        folderId,
        continuationLink,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  },
);
it("late noncooperative HTTP response after caller cancellation releases its unread body", async () => {
  let deliver: ((response: Response) => void) | undefined;
  const pendingResponse = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pendingResponse);
  const caller = new AbortController();
  const pending = createOutlookGraphDiscovery(
    "synthetic-late-graph-access",
  ).folders({ signal: caller.signal });
  caller.abort();
  await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    }),
  );
  const reader = vi.spyOn(
    response.body as ReadableStream<Uint8Array>,
    "getReader",
  );
  if (!deliver) throw new Error("Synthetic HTTP response resolver missing");
  deliver(response);
  await pendingResponse;
  await Promise.resolve();
  await Promise.resolve();
  expect(canceled).toBe(true);
  expect(reader).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
