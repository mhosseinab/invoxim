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
export interface OutlookInventoryContinuation {
  jobId: string;
  priority: 0 | 1 | 2;
  dispatchAt: number;
  excludedFolderIds?: string[];
}
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
      excludedFolderIds?: string[];
    }
  | { kind: "complete"; excludedFolderIds?: string[] }
  | { kind: "stale" }
  | { kind: "limit" };
const maximumFolders = 2000;
const excludedIdsSchema = z
  .array(id)
  .length(4)
  .refine((ids) => new Set(ids).size === ids.length);
function parseExcludedIds(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    return excludedIdsSchema.parse(JSON.parse(value));
  } catch {
    throw new DiscoveryError("UNAVAILABLE");
  }
}

function authorization(lease: JobLease, now: number) {
  return {
    sql: `EXISTS(SELECT 1 FROM jobs j JOIN connections c ON c.user_id=j.user_id AND c.id=j.connection_id JOIN profiles p ON p.user_id=j.user_id JOIN processing_consents pc ON pc.user_id=j.user_id AND pc.id=j.consent_id AND pc.connection_id=j.connection_id WHERE j.user_id=? AND j.id=? AND j.connection_id=? AND j.consent_id=? AND j.connection_generation=? AND j.status='leased' AND j.lease_id=? AND j.fence=? AND j.lease_expires_at>? AND j.type IN ('mailbox-backfill','discover','sync') AND c.provider='outlook' AND c.kind='mailbox' AND c.state='connected' AND c.scheduling_state='active' AND c.generation=j.connection_generation AND p.status='active' AND pc.revoked_at IS NULL AND pc.background_authorized=1 AND pc.accepted_at<=? AND pc.ai_settings_revision=COALESCE((SELECT a.revision FROM ai_settings a WHERE a.user_id=p.user_id AND a.status='active'),0) AND EXISTS(SELECT 1 FROM json_each(c.scopes) WHERE value='https://graph.microsoft.com/Mail.Read'))`,
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
          "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
        )
        .bind(...owner(lease))
        .first<{ excluded_folder_ids: string | null }>();
      const excludedFolderIds = parseExcludedIds(
        row?.excluded_folder_ids ?? null,
      );
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
            `WITH RECURSIVE excluded(folder_id) AS (SELECT value FROM json_each(?) UNION SELECT f.folder_id FROM outlook_folders f JOIN excluded e ON f.parent_folder_id=e.folder_id WHERE f.user_id=? AND f.connection_id=? AND f.generation=?) SELECT parent_folder_id,version,next_link FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND state='pending' AND (scope_key='root' OR parent_folder_id NOT IN (SELECT folder_id FROM excluded)) ORDER BY CASE WHEN scope_key='root' THEN 0 ELSE 1 END,scope_key LIMIT 1`,
          )
          .bind(
            JSON.stringify(excludedFolderIds ?? []),
            ...owner(lease),
            ...owner(lease),
          )
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
              ...(excludedFolderIds ? { excludedFolderIds } : {}),
            }
          : {
              kind: "complete",
              ...(excludedFolderIds ? { excludedFolderIds } : {}),
            };
      }
    }
    return (await allowed(lease)) ? result : { kind: "stale" };
  }

  async function saveExclusions(lease: JobLease, ids: string[]) {
    const validated = excludedIdsSchema.parse(ids);
    const guard = authorization(lease, Date.now());
    const result = await db
      .prepare(
        `UPDATE outlook_inventory_states SET excluded_folder_ids=? WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root' AND excluded_folder_ids IS NULL AND ${guard.sql}`,
      )
      .bind(JSON.stringify(validated), ...owner(lease), ...guard.values)
      .run();
    if (result.meta.changes === 1) return true;
    const existing = await db
      .prepare(
        "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root'",
      )
      .bind(...owner(lease))
      .first<{ excluded_folder_ids: string | null }>();
    return (
      JSON.stringify(
        parseExcludedIds(existing?.excluded_folder_ids ?? null),
      ) === JSON.stringify(validated) && (await allowed(lease))
    );
  }

  async function stageExclusions(
    lease: JobLease,
    ids: string[],
    continuation: OutlookInventoryContinuation,
  ) {
    const exclusions = excludedIdsSchema.parse(ids);
    const guard = authorization(lease, Date.now());
    const nonce = crypto.randomUUID();
    const marker =
      "EXISTS(SELECT 1 FROM outlook_inventory_states root WHERE root.user_id=? AND root.connection_id=? AND root.generation=? AND root.scope_key='root' AND root.commit_id=? AND root.excluded_folder_ids=?)";
    const markerValues = [...owner(lease), nonce, JSON.stringify(exclusions)];
    const dedupeKey = `outlook:inventory:${lease.jobId}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) SELECT ?,?,?,'root',NULL,1,NULL,'pending',?,? WHERE ${guard.sql} ON CONFLICT(user_id,connection_id,generation,scope_key) DO NOTHING`,
        )
        .bind(
          ...owner(lease),
          nonce,
          JSON.stringify(exclusions),
          ...guard.values,
        ),
      db
        .prepare(
          `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${marker} AND ${guard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        )
        .bind(
          continuation.jobId,
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          lease.syncStateId,
          lease.type,
          dedupeKey,
          continuation.dispatchAt,
          continuation.priority,
          ...markerValues,
          ...guard.values,
        ),
      db
        .prepare(
          `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${marker} AND ${guard.sql} AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')`,
        )
        .bind(
          lease.context.userId,
          lease.jobId,
          ...markerValues,
          ...guard.values,
          lease.context.userId,
          dedupeKey,
        ),
    ]);
    return Boolean(
      await db
        .prepare(
          "SELECT 1 FROM jobs WHERE user_id=? AND id=? AND status='completed'",
        )
        .bind(lease.context.userId, lease.jobId)
        .first(),
    );
  }

  async function deferRate(lease: JobLease, retryAfterMs: number) {
    const guard = authorization(lease, Date.now());
    if (!Number.isFinite(retryAfterMs) || retryAfterMs > 86400000) {
      const parent = await db
        .prepare(
          "SELECT discovery_version,import_run_id FROM sync_states WHERE user_id=? AND id=? AND connection_id=?",
        )
        .bind(lease.context.userId, lease.syncStateId, lease.connectionId)
        .first<{
          discovery_version: number;
          import_run_id: string | null;
        }>();
      if (!parent) return false;
      const nonce = crypto.randomUUID();
      const marker =
        "EXISTS(SELECT 1 FROM sync_states parent WHERE parent.user_id=? AND parent.id=? AND parent.discovery_version=? AND parent.pending_history_id=? AND parent.stage='paused_rate')";
      const markerValues = [
        lease.context.userId,
        lease.syncStateId,
        parent.discovery_version + 1,
        nonce,
      ];
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE sync_states SET stage='paused_rate',discovery_version=discovery_version+1,pending_history_id=? WHERE user_id=? AND id=? AND connection_id=? AND discovery_version=? AND ${guard.sql}`,
          )
          .bind(
            nonce,
            lease.context.userId,
            lease.syncStateId,
            lease.connectionId,
            parent.discovery_version,
            ...guard.values,
          ),
      ];
      if (parent.import_run_id)
        statements.push(
          db
            .prepare(
              `UPDATE import_runs SET stage='paused_rate' WHERE user_id=? AND id=? AND connection_id=? AND ${marker} AND ${guard.sql}`,
            )
            .bind(
              lease.context.userId,
              parent.import_run_id,
              lease.connectionId,
              ...markerValues,
              ...guard.values,
            ),
        );
      statements.push(
        db
          .prepare(
            `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='rate_paused' WHERE user_id=? AND id=? AND ${marker} AND ${guard.sql}${parent.import_run_id ? " AND EXISTS(SELECT 1 FROM import_runs r WHERE r.user_id=? AND r.id=? AND r.stage='paused_rate')" : ""}`,
          )
          .bind(
            lease.context.userId,
            lease.jobId,
            ...markerValues,
            ...guard.values,
            ...(parent.import_run_id
              ? [lease.context.userId, parent.import_run_id]
              : []),
          ),
      );
      await db.batch(statements);
      return Boolean(
        await db
          .prepare(
            "SELECT 1 FROM jobs WHERE user_id=? AND id=? AND status='completed' AND outcome_code='rate_paused'",
          )
          .bind(lease.context.userId, lease.jobId)
          .first(),
      );
    }
    const dispatchAt = Date.now() + Math.max(1000, retryAfterMs);
    const dedupeKey = `outlook:rate:${lease.jobId}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${guard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          lease.context.userId,
          lease.connectionId,
          lease.consentId,
          lease.generation,
          lease.syncStateId,
          lease.type,
          dedupeKey,
          dispatchAt,
          lease.type === "sync" ? 0 : 1,
          ...guard.values,
        ),
      db
        .prepare(
          `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='rate_deferred' WHERE user_id=? AND id=? AND ${guard.sql} AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')`,
        )
        .bind(
          lease.context.userId,
          lease.jobId,
          ...guard.values,
          lease.context.userId,
          dedupeKey,
        ),
    ]);
    return Boolean(
      await db
        .prepare(
          "SELECT 1 FROM jobs WHERE user_id=? AND id=? AND status='completed'",
        )
        .bind(lease.context.userId, lease.jobId)
        .first(),
    );
  }

  async function commitInventoryPage(
    lease: JobLease,
    input: OutlookInventoryPage,
    continuation?: OutlookInventoryContinuation,
  ): Promise<CommitResult> {
    const page = validatePage(input);
    if (
      continuation &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        continuation.jobId,
      ) ||
        ![0, 1, 2].includes(continuation.priority) ||
        !Number.isSafeInteger(continuation.dispatchAt) ||
        continuation.dispatchAt < 0)
    )
      throw new DiscoveryError("INVALID_RANGE");
    const exclusions = continuation?.excludedFolderIds
      ? excludedIdsSchema.parse(continuation.excludedFolderIds)
      : null;
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
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO outlook_inventory_states(user_id,connection_id,generation,scope_key,parent_folder_id,version,next_link,state,commit_id,excluded_folder_ids) SELECT ?,?,?,?,?,1,?,?,?,? WHERE ((?=0 AND ? IS NULL) OR EXISTS(SELECT 1 FROM outlook_inventory_states prior WHERE prior.user_id=? AND prior.connection_id=? AND prior.generation=? AND prior.scope_key=? AND prior.version=?)) AND ${guard.sql} AND ${cap} AND ${acyclic} ON CONFLICT(user_id,connection_id,generation,scope_key) DO UPDATE SET version=outlook_inventory_states.version+1,next_link=excluded.next_link,state=excluded.state,commit_id=excluded.commit_id,excluded_folder_ids=COALESCE(outlook_inventory_states.excluded_folder_ids,excluded.excluded_folder_ids) WHERE outlook_inventory_states.version=? AND outlook_inventory_states.version<2147483646 AND ${guard.sql} AND ${cap} AND ${acyclic}`,
        )
        .bind(
          ...owner(lease),
          key,
          page.parentFolderId,
          page.nextLink,
          page.nextLink ? "pending" : "complete",
          nonce,
          key === "root" && exclusions ? JSON.stringify(exclusions) : null,
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
    ];
    if (continuation) {
      const dedupeKey = `outlook:inventory:${lease.jobId}`;
      statements.push(
        db
          .prepare(
            `INSERT INTO jobs(id,user_id,connection_id,consent_id,connection_generation,sync_state_id,type,dedupe_key,status,dispatch_at,priority) SELECT ?,?,?,?,?,?,?,?,'ready',?,? WHERE ${marker} AND ${guard.sql} ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
          )
          .bind(
            continuation.jobId,
            lease.context.userId,
            lease.connectionId,
            lease.consentId,
            lease.generation,
            lease.syncStateId,
            lease.type,
            dedupeKey,
            continuation.dispatchAt,
            continuation.priority,
            ...markerValues,
            ...guard.values,
          ),
        db
          .prepare(
            `UPDATE jobs SET status='completed',lease_id=NULL,lease_expires_at=NULL,outcome_code='discovery_staged' WHERE user_id=? AND id=? AND ${marker} AND ${guard.sql} AND EXISTS(SELECT 1 FROM jobs continuation WHERE continuation.user_id=? AND continuation.dedupe_key=? AND continuation.status='ready')`,
          )
          .bind(
            lease.context.userId,
            lease.jobId,
            ...markerValues,
            ...guard.values,
            lease.context.userId,
            dedupeKey,
          ),
      );
    }
    await db.batch(statements);
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
  return {
    getNextInventory,
    saveExclusions,
    stageExclusions,
    deferRate,
    commitInventoryPage,
    checkpoint: allowed,
  };
}
