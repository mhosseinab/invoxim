import type { JobLease } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import { outlookLeaseGuard } from "./outlook-guard";
import {
  validateOutlookContinuation,
  validateOutlookId,
} from "./outlook-transport";
import { rateDecision } from "./rate-decision";
import {
  completeStagedJob,
  stageAndSettle,
  stageContinuation,
  stageGuard,
} from "./stage-and-settle";

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
/**
 * Read with the inventory's closing live check: what a rate deferral needs
 * without another statement. `dedupeKey` is the leased job's key, whose
 * `outlook:rate:<n>:` prefix counts consecutive rate deferrals (G4).
 */
export interface OutlookRateContext {
  dedupeKey: string | null;
  discoveryVersion: number | null;
  importRunId: string | null;
}
const rateKeyPattern = /^outlook:rate:([0-9]+):/;
/** Consecutive rate deferrals that led to this job; any other key resets it. */
function rateChainDepth(dedupeKey: string | null): number {
  const depth = Number(dedupeKey?.match(rateKeyPattern)?.[1] ?? 0);
  return Number.isSafeInteger(depth) ? depth : 0;
}
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
  return outlookLeaseGuard(lease, now, {
    types: ["mailbox-backfill", "discover", "sync"],
  });
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
  /** The guarded closing read: null when the lease is no longer live. */
  async function liveRateContext(
    lease: JobLease,
  ): Promise<OutlookRateContext | null> {
    const guard = authorization(lease, Date.now());
    const row = await db
      .prepare(
        `SELECT (SELECT dedupe_key FROM jobs WHERE user_id=? AND id=?) AS dedupe_key,(SELECT discovery_version FROM sync_states WHERE user_id=? AND id=? AND connection_id=?) AS discovery_version,(SELECT import_run_id FROM sync_states WHERE user_id=? AND id=? AND connection_id=?) AS import_run_id WHERE ${guard.sql}`,
      )
      .bind(
        lease.context.userId,
        lease.jobId,
        lease.context.userId,
        lease.syncStateId,
        lease.connectionId,
        lease.context.userId,
        lease.syncStateId,
        lease.connectionId,
        ...guard.values,
      )
      .first<{
        dedupe_key: string | null;
        discovery_version: number | null;
        import_run_id: string | null;
      }>();
    return row
      ? {
          dedupeKey: row.dedupe_key,
          discoveryVersion: row.discovery_version,
          importRunId: row.import_run_id,
        }
      : null;
  }
  async function readInventory(
    lease: JobLease,
  ): Promise<{ next: InventoryResult; rate: OutlookRateContext | null }> {
    if (!(await allowed(lease))) return { next: { kind: "stale" }, rate: null };
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
    const rate = await liveRateContext(lease);
    return rate ? { next: result, rate } : { next: { kind: "stale" }, rate };
  }
  async function getNextInventory(lease: JobLease): Promise<InventoryResult> {
    return (await readInventory(lease)).next;
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
    const staged = stageGuard({ sql: marker, values: markerValues }, guard);
    return stageAndSettle(
      db,
      lease,
      [
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
        stageContinuation(db, lease, staged, {
          id: continuation.jobId,
          dedupeKey,
          dispatchAt: continuation.dispatchAt,
          priority: continuation.priority,
        }),
        completeStagedJob(db, lease, staged, {
          outcome: "discovery_staged",
          continuationKey: dedupeKey,
        }),
      ],
      "read",
    );
  }

  /**
   * G4: defer or pause rate service through the shared rateDecision. The
   * consecutive count rides the continuation's dedupe key, so a successful
   * page (whose continuation key differs) resets it without another write.
   * Both paths are one batch whose final settlement reports the result.
   */
  async function deferRate(
    lease: JobLease,
    retryAfterMs: number | undefined,
    rate: OutlookRateContext,
  ) {
    const guard = authorization(lease, Date.now());
    const decision = rateDecision({
      retryAfterMs,
      consecutiveFailures: rateChainDepth(rate.dedupeKey),
    });
    if (decision.kind === "pause") {
      if (rate.discoveryVersion === null) return false;
      const nonce = crypto.randomUUID();
      const marker =
        "EXISTS(SELECT 1 FROM sync_states parent WHERE parent.user_id=? AND parent.id=? AND parent.discovery_version=? AND parent.pending_history_id=? AND parent.stage='paused_rate')";
      const markerValues = [
        lease.context.userId,
        lease.syncStateId,
        rate.discoveryVersion + 1,
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
            rate.discoveryVersion,
            ...guard.values,
          ),
      ];
      if (rate.importRunId)
        statements.push(
          db
            .prepare(
              `UPDATE import_runs SET stage='paused_rate' WHERE user_id=? AND id=? AND connection_id=? AND ${marker} AND ${guard.sql}`,
            )
            .bind(
              lease.context.userId,
              rate.importRunId,
              lease.connectionId,
              ...markerValues,
              ...guard.values,
            ),
        );
      statements.push(
        completeStagedJob(
          db,
          lease,
          stageGuard({ sql: marker, values: markerValues }, guard),
          {
            outcome: "rate_paused",
            ...(rate.importRunId
              ? {
                  also: {
                    sql: "EXISTS(SELECT 1 FROM import_runs r WHERE r.user_id=? AND r.id=? AND r.stage='paused_rate')",
                    values: [lease.context.userId, rate.importRunId],
                  },
                }
              : {}),
          },
        ),
      );
      return stageAndSettle(db, lease, statements, "last-change");
    }
    const dedupeKey = `outlook:rate:${decision.failures}:${lease.jobId}`;
    return stageAndSettle(
      db,
      lease,
      [
        stageContinuation(db, lease, guard, {
          dedupeKey,
          dispatchAt: Date.now() + decision.delayMs,
          priority: lease.type === "sync" ? 0 : 1,
        }),
        completeStagedJob(db, lease, guard, {
          outcome: "rate_deferred",
          continuationKey: dedupeKey,
        }),
      ],
      "last-change",
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
      const staged = stageGuard({ sql: marker, values: markerValues }, guard);
      statements.push(
        stageContinuation(db, lease, staged, {
          id: continuation.jobId,
          dedupeKey,
          dispatchAt: continuation.dispatchAt,
          priority: continuation.priority,
        }),
        completeStagedJob(db, lease, staged, {
          outcome: "discovery_staged",
          continuationKey: dedupeKey,
        }),
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
  async function refreshInventory(lease: JobLease, dispatchAt: number) {
    const guard = authorization(lease, Date.now());
    const ready = await db
      .prepare(
        `SELECT 1 FROM sync_states parent JOIN jobs j ON j.user_id=parent.user_id AND j.sync_state_id=parent.id WHERE parent.user_id=? AND parent.id=? AND parent.scope_key='mailbox' AND parent.sync_kind='incremental' AND parent.stage='idle' AND j.id=? AND j.type='sync' AND j.dedupe_key LIKE 'sync:%' AND ${guard.sql}`,
      )
      .bind(
        lease.context.userId,
        lease.syncStateId,
        lease.jobId,
        ...guard.values,
      )
      .first();
    if (!ready) return false;
    const nonce = crypto.randomUUID();
    const marker =
      "EXISTS(SELECT 1 FROM sync_states parent WHERE parent.user_id=? AND parent.id=? AND parent.pending_history_id=? AND parent.stage='queued')";
    const values = [lease.context.userId, lease.syncStateId, nonce];
    const dedupe = `outlook:refresh:${lease.jobId}`;
    const staged = stageGuard({ sql: marker, values }, guard);
    // O9: the 5-statement refresh batch settles through the same tail.
    return stageAndSettle(
      db,
      lease,
      [
        db
          .prepare(
            `UPDATE sync_states SET stage='queued',pending_history_id=? WHERE user_id=? AND id=? AND stage='idle' AND ${guard.sql}`,
          )
          .bind(
            nonce,
            lease.context.userId,
            lease.syncStateId,
            ...guard.values,
          ),
        db
          .prepare(
            `UPDATE outlook_inventory_states SET state='pending',next_link=NULL,version=version+1 WHERE user_id=? AND connection_id=? AND generation=? AND ${staged.sql}`,
          )
          .bind(...owner(lease), ...staged.values),
        db
          .prepare(
            `UPDATE sync_states SET stage='queued' WHERE user_id=? AND connection_id=? AND scope_key LIKE ? AND sync_kind='incremental' AND run_key='live' AND slice_key='live' AND stage='idle' AND ${staged.sql}`,
          )
          .bind(
            lease.context.userId,
            lease.connectionId,
            `outlook:${lease.generation}:%`,
            ...staged.values,
          ),
        stageContinuation(db, lease, staged, {
          type: "sync",
          dedupeKey: dedupe,
          dispatchAt,
          priority: 0,
        }),
        completeStagedJob(db, lease, staged, {
          outcome: "discovery_staged",
          continuationKey: dedupe,
        }),
      ],
      "last-change",
    );
  }
  return {
    refreshInventory,
    getNextInventory,
    readInventory,
    saveExclusions,
    stageExclusions,
    deferRate,
    commitInventoryPage,
    checkpoint: allowed,
  };
}
