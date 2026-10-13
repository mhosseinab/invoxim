import type { JobLease } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import {
  validateOutlookContinuation,
  validateOutlookId,
} from "./outlook-transport";

const id = z.string().refine((value) => Boolean(validateOutlookId(value)));
const pageSchema = z.strictObject({
  parentFolderId: id.nullable(),
  expectedVersion: z.number().int().min(0).max(2147483645),
  folders: z
    .array(
      z.strictObject({
        id,
        parentFolderId: id.nullable(),
        childFolderCount: z.number().int().min(0).max(100000),
        isHidden: z.boolean(),
      }),
    )
    .max(5),
  nextLink: z.string().min(1).max(4096).nullable(),
});
export type OutlookInventoryPage = z.infer<typeof pageSchema>;
type CommitResult =
  | { kind: "committed"; version: number }
  | { kind: "stale" }
  | { kind: "conflict" }
  | { kind: "limit" };
type InventoryResult =
  | {
      kind: "ready";
      parentFolderId: string | null;
      expectedVersion: number;
      nextLink: string | null;
    }
  | { kind: "complete" }
  | { kind: "stale" }
  | { kind: "limit" };
const maximumFolders = 2000;

function authorization(lease: JobLease, now: number) {
  return {
    sql: `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=j.user_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id WHERE j.user_id=? AND j.id=? AND j.connection_id=? AND j.consent_id=? AND j.connection_generation=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.type IN ('mailbox-backfill','sync') AND c.provider='outlook' AND c.kind='mailbox' AND c.state='connected' AND c.scheduling_state='active' AND c.generation=j.connection_generation AND p.status='active' AND pc.revoked_at IS NULL AND pc.background_authorized=1 AND pc.accepted_at<=? AND pc.ai_settings_revision=COALESCE((SELECT a.revision FROM ai_settings a WHERE a.user_id=p.user_id AND a.status='active'),0) AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='https://graph.microsoft.com/Mail.Read'))`,
    values: [
      lease.context.userId,
      lease.jobId,
      lease.connectionId,
      lease.consentId,
      lease.generation,
      lease.leaseId,
      lease.fence,
      now,
      now,
    ],
  };
}
function owner(lease: JobLease) {
  return [lease.context.userId, lease.connectionId, lease.generation];
}
function validatePage(input: OutlookInventoryPage) {
  const page = pageSchema.parse(input),
    seen = new Set<string>();
  for (const folder of page.folders) {
    if (
      seen.has(folder.id) ||
      folder.id === folder.parentFolderId ||
      (page.parentFolderId !== null &&
        folder.parentFolderId !== page.parentFolderId)
    )
      throw new DiscoveryError("INVALID_RANGE");
    seen.add(folder.id);
  }
  if (page.nextLink)
    validateOutlookContinuation(
      page.nextLink,
      {
        kind: "folders",
        ...(page.parentFolderId === null
          ? {}
          : { parentFolderId: page.parentFolderId }),
      },
      "next",
    );
  return page;
}
export function createOutlookFolderStore(db: D1Database) {
  async function allowed(lease: JobLease) {
    const guard = authorization(lease, Date.now());
    return Boolean(
      await db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first(),
    );
  }
  async function exceedsLimit(lease: JobLease, ids: string[] = []) {
    const count = await db
      .prepare(
        "SELECT COUNT(*) n FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=? AND folder_id NOT IN (SELECT value FROM json_each(?))",
      )
      .bind(...owner(lease), JSON.stringify(ids))
      .first<number>("n");
    return (count ?? 0) + ids.length > maximumFolders;
  }
  async function getNextInventory(lease: JobLease): Promise<InventoryResult> {
    if (!(await allowed(lease))) return { kind: "stale" };
    let result: InventoryResult;
    if (await exceedsLimit(lease)) result = { kind: "limit" };
    else {
      const row = await db
        .prepare(
          "SELECT scope_key FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? LIMIT 1",
        )
        .bind(...owner(lease))
        .first<{ scope_key: string }>();
      if (!row)
        result = {
          kind: "ready",
          parentFolderId: null,
          expectedVersion: 0,
          nextLink: null,
        };
      else {
        const pending = await db
          .prepare(
            "SELECT parent_folder_id,version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND state='pending' ORDER BY CASE WHEN scope_key='root' THEN 0 ELSE 1 END,scope_key LIMIT 1",
          )
          .bind(...owner(lease))
          .first<{
            parent_folder_id: string | null;
            version: number;
            next_link: string | null;
          }>();
        result = pending
          ? {
              kind: "ready",
              parentFolderId: pending.parent_folder_id,
              expectedVersion: pending.version,
              nextLink: pending.next_link,
            }
          : { kind: "complete" };
      }
    }
    return (await allowed(lease)) ? result : { kind: "stale" };
  }

  async function commitInventoryPage(
    lease: JobLease,
    input: OutlookInventoryPage,
  ): Promise<CommitResult> {
    const page = validatePage(input);
    if (!(await allowed(lease))) return { kind: "stale" };
    if (
      await exceedsLimit(
        lease,
        page.folders.map((folder) => folder.id),
      )
    )
      return { kind: "limit" };
    const guard = authorization(lease, Date.now()),
      key =
        page.parentFolderId === null ? "root" : `folder:${page.parentFolderId}`,
      nonce = crypto.randomUUID();
    const folders = JSON.stringify(page.folders);
    const marker =
      "EXISTS(SELECT 1 FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key=? AND commit_id=?)";
    const markerValues = [...owner(lease), key, nonce];
    const cap =
      "((SELECT COUNT(*) FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=?)+(SELECT COUNT(*) FROM json_each(?) f WHERE NOT EXISTS(SELECT 1 FROM outlook_folders existing WHERE existing.user_id=? AND existing.connection_id=? AND existing.generation=? AND existing.folder_id=json_extract(f.value,'$.id'))))<=2000";
    const acyclic = `NOT EXISTS(WITH RECURSIVE proposed(id,parent) AS (SELECT folder_id,parent_folder_id FROM outlook_folders WHERE user_id=? AND connection_id=? AND generation=? AND folder_id NOT IN(SELECT json_extract(value,'$.id') FROM json_each(?)) UNION ALL SELECT json_extract(value,'$.id'),json_extract(value,'$.parentFolderId') FROM json_each(?)),ancestry(origin,id,depth) AS (SELECT json_extract(value,'$.id'),json_extract(value,'$.parentFolderId'),1 FROM json_each(?) UNION ALL SELECT a.origin,p.parent,a.depth+1 FROM ancestry a JOIN proposed p ON p.id=a.id WHERE a.id IS NOT NULL AND a.id!=a.origin AND a.depth<2001) SELECT 1 FROM ancestry WHERE id=origin OR depth>=2001 LIMIT 1)`;
    const acyclicValues = [...owner(lease), folders, folders, folders];
    await db.batch([
      db
        .prepare(
          `INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id) SELECT ?,?,?,?,?,1,?,?,? WHERE ((?=0 AND ? IS NULL) OR EXISTS(SELECT 1 FROM outlook_inventory_states prior WHERE prior.user_id=? AND prior.connection_id=? AND prior.generation=? AND prior.scope_key=? AND prior.version=?)) AND ${guard.sql} AND ${cap} AND ${acyclic} ON CONFLICT(user_id,connection_id,generation,scope_key) DO UPDATE SET version=outlook_inventory_states.version+1,next_link=excluded.next_link,state=excluded.state,commit_id=excluded.commit_id WHERE outlook_inventory_states.version=? AND outlook_inventory_states.version<2147483646 AND ${guard.sql} AND ${cap} AND ${acyclic}`,
        )
        .bind(
          ...owner(lease),
          key,
          page.parentFolderId,
          page.nextLink,
          page.nextLink ? "pending" : "complete",
          nonce,
          page.expectedVersion,
          page.parentFolderId,
          ...owner(lease),
          key,
          page.expectedVersion,
          ...guard.values,
          ...owner(lease),
          folders,
          ...owner(lease),
          ...acyclicValues,
          page.expectedVersion,
          ...guard.values,
          ...owner(lease),
          folders,
          ...owner(lease),
          ...acyclicValues,
        ),
      db
        .prepare(
          `INSERT INTO outlook_folders(user_id,connection_id,generation,folder_id,parent_folder_id,child_folder_count,is_hidden) SELECT ?,?,?,json_extract(f.value,'$.id'),json_extract(f.value,'$.parentFolderId'),json_extract(f.value,'$.childFolderCount'),json_extract(f.value,'$.isHidden') FROM json_each(?) f WHERE ${marker} ON CONFLICT(user_id,connection_id,generation,folder_id) DO UPDATE SET parent_folder_id=excluded.parent_folder_id,child_folder_count=excluded.child_folder_count,is_hidden=excluded.is_hidden`,
        )
        .bind(...owner(lease), folders, ...markerValues),
      db
        .prepare(
          `INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id) SELECT ?,?,?,'folder:'||json_extract(f.value,'$.id'),json_extract(f.value,'$.id'),1,NULL,'pending',? FROM json_each(?) f WHERE json_extract(f.value,'$.childFolderCount')>0 AND ${marker} ON CONFLICT(user_id,connection_id,generation,scope_key) DO NOTHING`,
        )
        .bind(...owner(lease), nonce, folders, ...markerValues),
    ]);
    const committed = await db
      .prepare(
        "SELECT version FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key=? AND commit_id=?",
      )
      .bind(...markerValues)
      .first<number>("version");
    return committed
      ? { kind: "committed", version: committed }
      : !(await allowed(lease))
        ? { kind: "stale" }
        : { kind: "conflict" };
  }
  return { getNextInventory, commitInventoryPage };
}
