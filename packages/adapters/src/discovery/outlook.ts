import type { DiscoveryMetadata, DiscoveryRange } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import {
  createOutlookGraphTransport,
  validateOutlookContinuation,
  validateOutlookId,
} from "./outlook-transport";

export interface OutlookFolder {
  id: string;
  parentFolderId: string;
  displayName: string;
  childFolderCount: number;
  isHidden: boolean;
}
export interface OutlookFolderPage {
  folders: OutlookFolder[];
  nextLink?: string;
}
export interface OutlookMessagePage {
  ids: string[];
  nextLink?: string;
}
export interface OutlookDeltaPage extends OutlookMessagePage {
  folderRemovedIds: string[];
  deltaLink?: string;
}
export interface OutlookMetadata extends DiscoveryMetadata {
  parentFolderId: string | null;
}
export interface OutlookGraphDiscoveryPort {
  folders(input: {
    parentFolderId?: string;
    nextLink?: string;
    signal: AbortSignal;
  }): Promise<OutlookFolderPage>;
  folder(id: string, signal: AbortSignal): Promise<OutlookFolder>;
  listFolder(input: {
    folderId: string;
    range: DiscoveryRange;
    nextLink?: string;
    signal: AbortSignal;
  }): Promise<OutlookMessagePage>;
  deltaFolder(input: {
    folderId: string;
    continuationLink?: string;
    signal: AbortSignal;
  }): Promise<OutlookDeltaPage>;
  metadata(id: string, signal: AbortSignal): Promise<OutlookMetadata>;
}
const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_+=/-]+$/);
const folderSchema = z.object({
  id: idSchema,
  parentFolderId: idSchema,
  displayName: z.string().max(256),
  childFolderCount: z.number().int().min(0).max(2147483647),
  isHidden: z.boolean(),
});
const folderPageSchema = z.object({
  value: z.array(folderSchema).max(5),
  "@odata.nextLink": z.string().min(1).max(4096).optional(),
});
const messagePageSchema = z.object({
  value: z.array(z.object({ id: idSchema })).max(5),
  "@odata.nextLink": z.string().min(1).max(4096).optional(),
});
const deltaPageSchema = z.object({
  value: z
    .array(
      z.object({
        id: idSchema,
        "@removed": z
          .object({ reason: z.string().max(100).optional() })
          .optional(),
      }),
    )
    .max(5),
  "@odata.nextLink": z.string().min(1).max(4096).optional(),
  "@odata.deltaLink": z.string().min(1).max(4096).optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DiscoveryError("UNAVAILABLE");
  return result.data;
}
const prefix = "https://graph.microsoft.com/v1.0/me";
const folderSelect = "id,parentFolderId,displayName,childFolderCount,isHidden";
export function createOutlookGraphDiscovery(
  accessToken: string,
  options: { pageSize?: 1 | 5 } = {},
): OutlookGraphDiscoveryPort {
  const pageSize = options.pageSize ?? 5;
  const request = createOutlookGraphTransport(accessToken, pageSize);
  return {
    async folders(input) {
      const parent =
        input.parentFolderId === undefined
          ? undefined
          : validateOutlookId(input.parentFolderId);
      const collection = parent
        ? `${prefix}/mailFolders/${encodeURIComponent(parent)}/childFolders`
        : `${prefix}/mailFolders`;
      const scope = {
        kind: "folders" as const,
        ...(parent ? { parentFolderId: parent } : {}),
      };
      const url =
        input.nextLink !== undefined
          ? validateOutlookContinuation(input.nextLink, scope)
          : `${collection}?${new URLSearchParams({ $select: folderSelect, $top: String(pageSize), includeHiddenFolders: "true" })}`;
      const result = parse(
        folderPageSchema,
        await request(url, input.signal, "collection"),
      );
      if (result.value.length > pageSize)
        throw new DiscoveryError("UNAVAILABLE");
      const nextLink = result["@odata.nextLink"];
      if (
        parent &&
        result.value.some((folder) => folder.parentFolderId !== parent)
      )
        throw new DiscoveryError("UNAVAILABLE");
      if (nextLink === url) throw new DiscoveryError("UNAVAILABLE");
      return {
        folders: result.value,
        ...(nextLink
          ? { nextLink: validateOutlookContinuation(nextLink, scope, "next") }
          : {}),
      };
    },
    async folder(id, signal) {
      validateOutlookId(id);
      const result = parse(
        folderSchema,
        await request(
          `${prefix}/mailFolders/${encodeURIComponent(id)}?${new URLSearchParams({ $select: folderSelect })}`,
          signal,
          "folder",
        ),
      );
      // Well-known Graph aliases resolve locale-independent IDs; ordinary IDs must correlate.
      if (
        ![
          "junkemail",
          "deleteditems",
          "drafts",
          "sentitems",
          "archive",
          "inbox",
          "msgfolderroot",
        ].includes(id) &&
        result.id !== id
      )
        throw new DiscoveryError("UNAVAILABLE");
      return result;
    },
    async listFolder(input) {
      validateOutlookId(input.folderId);
      if (
        !Number.isSafeInteger(input.range.startMs) ||
        !Number.isSafeInteger(input.range.cutoffMs) ||
        input.range.startMs < 0 ||
        input.range.cutoffMs <= input.range.startMs ||
        input.range.cutoffMs > 8640000000000000
      )
        throw new DiscoveryError("INVALID_RANGE");
      const filter = `receivedDateTime ge ${new Date(input.range.startMs).toISOString()} and receivedDateTime lt ${new Date(input.range.cutoffMs).toISOString()}`;
      const scope = {
        kind: "messages" as const,
        folderId: input.folderId,
        filter,
      };
      const url =
        input.nextLink !== undefined
          ? validateOutlookContinuation(input.nextLink, scope)
          : `${prefix}/mailFolders/${encodeURIComponent(input.folderId)}/messages?${new URLSearchParams({ $select: "id", $top: String(pageSize), $filter: filter })}`;
      const result = parse(
        messagePageSchema,
        await request(url, input.signal, "collection"),
      );
      if (result.value.length > pageSize)
        throw new DiscoveryError("UNAVAILABLE");
      const nextLink = result["@odata.nextLink"];
      if (nextLink === url) throw new DiscoveryError("UNAVAILABLE");
      return {
        ids: [...new Set(result.value.map((message) => message.id))],
        ...(nextLink
          ? { nextLink: validateOutlookContinuation(nextLink, scope, "next") }
          : {}),
      };
    },
    async deltaFolder(input) {
      validateOutlookId(input.folderId);
      const scope = { kind: "delta" as const, folderId: input.folderId };
      const url =
        input.continuationLink !== undefined
          ? validateOutlookContinuation(input.continuationLink, scope)
          : `${prefix}/mailFolders/${encodeURIComponent(input.folderId)}/messages/delta?${new URLSearchParams({ $select: "id" })}`;
      const result = parse(
        deltaPageSchema,
        await request(url, input.signal, "delta"),
      );
      if (result.value.length > pageSize)
        throw new DiscoveryError("UNAVAILABLE");
      const nextLink = result["@odata.nextLink"],
        deltaLink = result["@odata.deltaLink"];
      if (Boolean(nextLink) === Boolean(deltaLink) || nextLink === url)
        throw new DiscoveryError("UNAVAILABLE");
      const ids = new Set<string>(),
        removed = new Set<string>();
      for (const message of result.value) {
        if (message["@removed"]) removed.add(message.id);
        else ids.add(message.id);
      }
      // A removal is local folder membership, never proof of mailbox-global deletion.
      return {
        ids: [...ids],
        folderRemovedIds: [...removed],
        ...(nextLink
          ? { nextLink: validateOutlookContinuation(nextLink, scope, "next") }
          : {}),
        ...(deltaLink
          ? {
              deltaLink: validateOutlookContinuation(deltaLink, scope, "delta"),
            }
          : {}),
      };
    },
    async metadata(id, signal) {
      validateOutlookId(id);
      let result: {
        id: string;
        parentFolderId: string;
        receivedDateTime: string;
        isDraft: boolean;
      };
      try {
        result = parse(
          z.object({
            id: idSchema,
            parentFolderId: idSchema,
            receivedDateTime: z.iso.datetime(),
            isDraft: z.boolean(),
          }),
          await request(
            `${prefix}/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: "id,parentFolderId,receivedDateTime,isDraft" })}`,
            signal,
            "metadata",
          ),
        );
      } catch (error) {
        if (
          error instanceof DiscoveryError &&
          error.code === "SOURCE_UNAVAILABLE"
        )
          return {
            id,
            parentFolderId: null,
            receivedAtMs: 0,
            available: false,
            excluded: true,
            candidate: "unknown",
          };
        throw error;
      }
      const receivedAtMs = Date.parse(result.receivedDateTime);
      if (
        result.id !== id ||
        !Number.isSafeInteger(receivedAtMs) ||
        receivedAtMs < 0
      )
        throw new DiscoveryError("UNAVAILABLE");
      return {
        id,
        parentFolderId: result.parentFolderId,
        receivedAtMs,
        available: true,
        excluded: result.isDraft,
        candidate: "unknown",
      };
    },
  };
}
