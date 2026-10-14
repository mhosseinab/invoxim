import { DiscoveryError } from "@invoxim/core";

const graphOrigin = "https://graph.microsoft.com";
export type OutlookCollection =
  | { kind: "folders"; parentFolderId?: string }
  | { kind: "messages"; folderId: string; filter: string }
  | { kind: "delta"; folderId: string };
function unavailable(): never {
  throw new DiscoveryError("UNAVAILABLE");
}
export function validateOutlookId(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_+=/-]{1,256}$/.test(value))
    unavailable();
  return value;
}
export function validateOutlookContinuation(
  value: string,
  scope: OutlookCollection,
  expectedToken?: "next" | "delta",
) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.includes("\\")
  )
    unavailable();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return unavailable();
  }
  if (url.origin !== graphOrigin || url.username || url.password || url.hash)
    unavailable();
  const path = url.pathname;
  if (scope.kind === "folders" && !scope.parentFolderId) {
    if (!/^\/v1\.0\/me\/mailFolders\/?$/i.test(path)) unavailable();
  } else {
    const match =
      /^\/v1\.0\/me\/mailFolders(?:\/([^/]+)|\('([^']+)'\))(\/childFolders|\/messages(?:\/delta)?)\/?$/i.exec(
        path,
      );
    if (!match) unavailable();
    let folderId: string;
    try {
      folderId = decodeURIComponent(match[1] ?? match[2] ?? "");
    } catch {
      return unavailable();
    }
    const expected =
      scope.kind === "folders" ? scope.parentFolderId : scope.folderId;
    if (folderId !== expected || !/^[A-Za-z0-9_+=/-]{1,256}$/.test(folderId))
      unavailable();
    const suffix = match[3]?.toLowerCase();
    if (
      suffix !==
      (scope.kind === "folders"
        ? "/childfolders"
        : scope.kind === "messages"
          ? "/messages"
          : "/messages/delta")
    )
      unavailable();
  }
  const pagingKeys =
    scope.kind === "delta"
      ? ["$skiptoken", "$deltatoken"]
      : ["$skiptoken", "$skip"];
  const present = pagingKeys.filter((key) => url.searchParams.has(key));
  if (
    present.length !== 1 ||
    !url.searchParams.get(present[0] ?? "") ||
    (expectedToken === "delta" && present[0] !== "$deltatoken") ||
    (expectedToken === "next" && present[0] === "$deltatoken")
  )
    unavailable();
  // Validate permitted metadata options without rewriting opaque paging values.
  const select =
    scope.kind === "folders"
      ? "id,parentFolderId,displayName,childFolderCount,isHidden"
      : "id";
  for (const [key, option] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) unavailable();
    if (pagingKeys.includes(key)) continue;
    if (key === "$top" && /^[1-5]$/.test(option)) continue;
    if (key === "$select" && option === select) continue;
    if (
      key === "includeHiddenFolders" &&
      scope.kind === "folders" &&
      option === "true"
    )
      continue;
    if (
      key === "$filter" &&
      scope.kind === "messages" &&
      option === scope.filter
    )
      continue;
    unavailable();
  }
  return value;
}
export function createOutlookGraphTransport(
  accessToken: string,
  pageSize: 1 | 5 = 5,
  fetcher: typeof fetch = fetch,
) {
  if (
    typeof accessToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(accessToken)
  )
    unavailable();
  let requests = 0;
  return async function request(
    url: string,
    signal: AbortSignal,
    mode: "metadata" | "folder" | "collection" | "delta",
  ): Promise<unknown> {
    if (signal.aborted || ++requests > 12) unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + 10000;
    const timer = setTimeout(abort, 10000);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new DiscoveryError("UNAVAILABLE"));
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    try {
      response = await Promise.race([
        fetcher(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Prefer: `IdType="ImmutableId", odata.maxpagesize=${pageSize}`,
          },
          redirect: "manual",
          signal: controller.signal,
        }).then((received) => {
          if (controller.signal.aborted && received.body) {
            try {
              void received.body.cancel().catch(() => {});
            } catch {
              // A late response cannot retain work after this request has ended.
            }
          }
          return received;
        }),
        stopped,
      ]);
      if (response.status === 401 || response.status === 403)
        throw new DiscoveryError("AUTH_REQUIRED");
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get("retry-after");
        const delay =
          header && /^[0-9]+$/.test(header)
            ? Number(header) * 1000
            : header
              ? Date.parse(header) - Date.now()
              : 30000;
        throw new DiscoveryError(
          "RATE_LIMITED",
          Number.isFinite(delay) ? Math.max(1000, delay) : 86400001,
        );
      }
      if (response.status === 410 && mode === "delta")
        throw new DiscoveryError("HISTORY_EXPIRED");
      if (response.status === 404 && (mode === "metadata" || mode === "folder"))
        throw new DiscoveryError("SOURCE_UNAVAILABLE");
      if (
        (response.status >= 300 && response.status < 400) ||
        Number(response.headers.get("content-length")) > 65536
      )
        unavailable();
      reader = response.body?.getReader();
      if (!reader) unavailable();
      const bytes = new Uint8Array(65536);
      let length = 0;
      let dataChunks = 0;
      let emptyChunks = 0;
      const checkDeadline = () => {
        if (controller.signal.aborted || Date.now() >= deadline) unavailable();
      };
      while (true) {
        checkDeadline();
        const chunk = await Promise.race([reader.read(), stopped]);
        checkDeadline();
        if (chunk.done) break;
        if (chunk.value.byteLength === 0) {
          if (++emptyChunks > 32) unavailable();
          continue;
        }
        if (
          ++dataChunks > 4096 ||
          length + chunk.value.byteLength > bytes.length
        )
          unavailable();
        bytes.set(chunk.value, length);
        length += chunk.value.byteLength;
      }
      const body: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(0, length),
        ),
      );
      if (!response.ok) {
        if (
          mode === "delta" &&
          response.status >= 400 &&
          response.status < 500 &&
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "code" in body.error &&
          body.error.code === "syncStateNotFound"
        )
          throw new DiscoveryError("HISTORY_EXPIRED");
        unavailable();
      }
      return body;
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {});
      if (error instanceof DiscoveryError) throw error;
      unavailable();
    } finally {
      controller.abort();
      if (!reader && response?.body)
        void response.body.cancel().catch(() => {});
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (stop) controller.signal.removeEventListener("abort", stop);
      reader?.releaseLock();
    }
  };
}
