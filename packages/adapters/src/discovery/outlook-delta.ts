import type { JobLease, JobOutcome } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import { z } from "zod";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import { OUTLOOK_STATEMENTS, outlookBudgetShortfall } from "./outlook-budget";
import { commitFolderPage } from "./outlook-delta-page";
import { advanceParent } from "./outlook-delta-parent";
import { deferFolderRate, resetExpired } from "./outlook-delta-recovery";
import {
  type DeltaControl,
  excludedTreeSql,
  exclusionOwner,
  type FolderState,
  type OutlookDeltaContext,
  type ParentState,
} from "./outlook-delta-shared";
import {
  validateOutlookContinuation,
  validateOutlookId,
} from "./outlook-transport";

const pageSchema = z.object({
  ids: z.array(z.string()).max(5),
  folderRemovedIds: z.array(z.string()).max(5),
  nextLink: z.string().optional(),
  deltaLink: z.string().optional(),
});
const metadataSchema = z.object({
  id: z.string(),
  parentFolderId: z.string().nullable(),
  receivedAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  available: z.boolean(),
  excluded: z.boolean(),
  candidate: z.enum(["matched", "unknown"]),
});
/**
 * Runs one Outlook folder-discovery step for a leased discover/sync job.
 * G11: the parent advance, recovery/rate and page-commit steps live in
 * outlook-delta-{parent,recovery,page}.ts; this module path is unchanged.
 */
export function createOutlookDeltaRunner(
  db: D1Database,
  options: { remainingStatements: () => number; clock?: () => number },
) {
  const clock = options.clock ?? Date.now;
  const context: OutlookDeltaContext = { db, clock, options };
  return {
    async run(
      lease: JobLease,
      control: DeltaControl,
      provider: OutlookGraphDiscoveryPort,
    ): Promise<JobOutcome> {
      if (!lease.syncStateId)
        return { kind: "paused", code: "handler-unavailable" };
      const now = clock();
      const exclusions = await db
        .prepare(
          "SELECT excluded_folder_ids FROM outlook_inventory_states WHERE user_id=? AND connection_id=? AND generation=? AND scope_key='root' AND state='complete'",
        )
        .bind(lease.context.userId, lease.connectionId, lease.generation)
        .first<{ excluded_folder_ids: string | null }>();
      if (!exclusions?.excluded_folder_ids)
        return { kind: "paused", code: "auth" };
      const parent = await db
        .prepare(
          "SELECT id,import_run_id,run_key,slice_key,sync_kind,stage,frozen_start,frozen_cutoff,discovery_version FROM sync_states WHERE user_id=? AND id=? AND connection_id=? AND scope_key='mailbox'",
        )
        .bind(lease.context.userId, lease.syncStateId, lease.connectionId)
        .first<ParentState>();
      if (!parent || parent.stage === "waiting_recent")
        return { kind: "paused", code: "auth" };
      const approved =
        parent.sync_kind === "incremental"
          ? await db
              .prepare(
                "SELECT frozen_start FROM import_runs WHERE user_id=? AND connection_id=? AND consent_id=? AND connection_generation=? ORDER BY started_at DESC,id DESC LIMIT 1",
              )
              .bind(
                lease.context.userId,
                lease.connectionId,
                lease.consentId,
                lease.generation,
              )
              .first<{ frozen_start: string }>()
          : null;
      if (parent.sync_kind === "incremental" && !approved)
        return { kind: "paused", code: "auth" };
      const approvedStartMs = Date.parse(
        approved?.frozen_start ?? parent.frozen_start ?? "",
      );
      if (!Number.isSafeInteger(approvedStartMs) || approvedStartMs < 0)
        return { kind: "terminal", code: "malformed" };
      const folder = await db
        .prepare(
          `${excludedTreeSql} SELECT s.id,f.folder_id,s.discovery_version,s.page_token,s.history_cursor,s.stage,s.history_reset_count,s.consecutive_failures,s.retry_at,s.frozen_start,s.frozen_cutoff FROM sync_states s JOIN outlook_folders f ON f.user_id=s.user_id AND f.connection_id=s.connection_id AND f.generation=? AND s.scope_key='outlook:'||f.generation||':'||f.folder_id WHERE s.user_id=? AND s.connection_id=? AND s.run_key=? AND s.slice_key=? AND s.sync_kind=? AND s.stage IN ('queued','recovering','recovering_delta') AND f.folder_id NOT IN (SELECT folder_id FROM excluded) ORDER BY f.folder_id LIMIT 1`,
        )
        .bind(
          ...exclusionOwner(lease),
          lease.generation,
          lease.context.userId,
          lease.connectionId,
          parent.run_key,
          parent.slice_key,
          parent.sync_kind,
        )
        .first<FolderState>();
      if (!folder) return advanceParent(context, lease, control, parent);
      if (folder.retry_at !== null && folder.retry_at > now)
        return deferFolderRate(
          context,
          lease,
          control,
          folder,
          folder.retry_at - now,
          false,
        );
      if (options.remainingStatements() < OUTLOOK_STATEMENTS.folderPage)
        return outlookBudgetShortfall();
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      const continuation = folder.page_token ?? folder.history_cursor;
      const listing =
        parent.sync_kind === "backfill" || folder.stage === "recovering";
      let received: z.infer<typeof pageSchema>;
      try {
        received = listing
          ? await provider
              .listFolder({
                folderId: folder.folder_id,
                range: {
                  startMs: Date.parse(
                    folder.frozen_start ?? parent.frozen_start ?? "",
                  ),
                  cutoffMs: Date.parse(
                    folder.frozen_cutoff ?? parent.frozen_cutoff ?? "",
                  ),
                  timezone: "UTC",
                },
                ...(folder.page_token ? { nextLink: folder.page_token } : {}),
                signal: control.signal,
              })
              .then((value) => ({ ...value, folderRemovedIds: [] }))
          : await provider.deltaFolder({
              folderId: folder.folder_id,
              ...(continuation ? { continuationLink: continuation } : {}),
              signal: control.signal,
            });
      } catch (cause) {
        if (cause instanceof DiscoveryError && cause.code === "HISTORY_EXPIRED")
          return resetExpired(context, lease, control, folder);
        if (cause instanceof DiscoveryError && cause.code === "RATE_LIMITED")
          return deferFolderRate(
            context,
            lease,
            control,
            folder,
            cause.retryAfterMs,
          );
        throw cause;
      }
      const page = pageSchema.parse(received);
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      if (page.ids.length + page.folderRemovedIds.length > 5)
        throw new DiscoveryError("UNAVAILABLE");
      const ids = [...new Set(page.ids.map(validateOutlookId))];
      const removed = [
        ...new Set(page.folderRemovedIds.map(validateOutlookId)),
      ];
      const scope = listing
        ? {
            kind: "messages" as const,
            folderId: folder.folder_id,
            filter: `receivedDateTime ge ${new Date(folder.frozen_start ?? parent.frozen_start ?? "").toISOString()} and receivedDateTime lt ${new Date(folder.frozen_cutoff ?? parent.frozen_cutoff ?? "").toISOString()}`,
          }
        : { kind: "delta" as const, folderId: folder.folder_id };
      const nextLink = page.nextLink
        ? validateOutlookContinuation(page.nextLink, scope, "next")
        : null;
      const deltaLink = page.deltaLink
        ? validateOutlookContinuation(
            page.deltaLink,
            { kind: "delta", folderId: folder.folder_id },
            "delta",
          )
        : null;
      if (
        (nextLink !== null && nextLink === continuation) ||
        (nextLink === null && !listing && !deltaLink) ||
        (nextLink !== null && deltaLink !== null)
      )
        throw new DiscoveryError("UNAVAILABLE");
      const metadata = [];
      for (const id of [...ids, ...removed]) {
        if (control.signal.aborted || !(await control.checkpoint()))
          return { kind: "paused", code: "auth" };
        let value: z.infer<typeof metadataSchema>;
        try {
          value = metadataSchema.parse(
            await provider.metadata(id, control.signal),
          );
        } catch (cause) {
          if (cause instanceof DiscoveryError && cause.code === "RATE_LIMITED")
            return deferFolderRate(
              context,
              lease,
              control,
              folder,
              cause.retryAfterMs,
            );
          throw cause;
        }
        if (value.id !== id) throw new DiscoveryError("UNAVAILABLE");
        metadata.push({ ...value, removed: removed.includes(id) });
      }
      if (control.signal.aborted || !(await control.checkpoint()))
        return { kind: "paused", code: "auth" };
      if (
        options.remainingStatements() <
        metadata.length * OUTLOOK_STATEMENTS.folderCommitPerReference +
          OUTLOOK_STATEMENTS.folderCommitFixed
      )
        return outlookBudgetShortfall();
      return commitFolderPage(context, lease, {
        parent,
        folder,
        metadata,
        nextLink,
        deltaLink,
        approvedStartMs,
        now,
      });
    },
  };
}
