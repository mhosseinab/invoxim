import type { JobLease, JobOutcome } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import { OUTLOOK_STATEMENTS, outlookBudgetShortfall } from "./outlook-budget";
import { createOutlookDeltaRunner } from "./outlook-delta";
import {
  createOutlookFolderStore,
  type OutlookRateContext,
} from "./outlook-state";
import { validateOutlookId } from "./outlook-transport";

const excludedAliases = [
  "junkemail",
  "deleteditems",
  "drafts",
  "sentitems",
] as const;

export interface OutlookJobOptions {
  open: (
    lease: JobLease,
    signal: AbortSignal,
  ) => Promise<OutlookGraphDiscoveryPort>;
  remainingStatements: () => number;
  clock?: () => number;
}

/** Coordinates one durable Outlook inventory or folder-discovery page. */
export function createOutlookJobRunner(
  db: D1Database,
  options: OutlookJobOptions,
) {
  const store = createOutlookFolderStore(db);
  const delta = createOutlookDeltaRunner(db, options);
  const clock = options.clock ?? Date.now;
  return {
    async run(
      lease: JobLease,
      control: { signal: AbortSignal; checkpoint: () => Promise<boolean> },
    ): Promise<JobOutcome> {
      if (!lease.syncStateId || !["discover", "sync"].includes(lease.type))
        return { kind: "paused", code: "handler-unavailable" };
      const active = async () =>
        !control.signal.aborted &&
        (await control.checkpoint()) &&
        !control.signal.aborted;
      const resolveExclusions = async (provider: OutlookGraphDiscoveryPort) => {
        const ids: string[] = [];
        for (const alias of excludedAliases) {
          if (!(await active())) throw new DiscoveryError("AUTH_REQUIRED");
          const folder = await provider.folder(alias, control.signal);
          if (!(await active())) throw new DiscoveryError("AUTH_REQUIRED");
          ids.push(validateOutlookId(folder.id));
        }
        if (new Set(ids).size !== ids.length)
          throw new DiscoveryError("UNAVAILABLE");
        return ids;
      };
      let rate: OutlookRateContext | null = null;
      try {
        if (options.remainingStatements() < OUTLOOK_STATEMENTS.jobStart)
          return outlookBudgetShortfall();
        if (!(await active())) return { kind: "paused", code: "auth" };
        let read = await store.readInventory(lease);
        let next = read.next;
        rate = read.rate;
        if (next.kind === "stale") return { kind: "paused", code: "auth" };
        if (next.kind === "limit")
          return { kind: "terminal", code: "unsupported" };
        if (
          next.kind === "complete" &&
          lease.type === "sync" &&
          (await store.refreshInventory(lease, clock()))
        )
          return { kind: "completed" };
        if (!(await active())) return { kind: "paused", code: "auth" };
        const provider = await options.open(lease, control.signal);
        if (!(await active())) return { kind: "paused", code: "auth" };
        // Refresh may consume this invocation; resume with the durable fresh token.
        if (
          options.remainingStatements() <
          (next.excludedFolderIds
            ? OUTLOOK_STATEMENTS.afterOpenWithExclusions
            : OUTLOOK_STATEMENTS.afterOpen)
        )
          return outlookBudgetShortfall();
        const excludedFolderIds =
          next.excludedFolderIds ?? (await resolveExclusions(provider));
        if (
          next.kind === "ready" &&
          next.expectedVersion === 0 &&
          next.excludedFolderIds === undefined &&
          options.remainingStatements() <
            OUTLOOK_STATEMENTS.stageExclusionsOnlyBelow
        ) {
          const staged = await store.stageExclusions(lease, excludedFolderIds, {
            jobId: crypto.randomUUID(),
            priority: lease.type === "sync" ? 0 : 1,
            dispatchAt: clock(),
          });
          return staged
            ? { kind: "completed" }
            : { kind: "retry", code: "transient" };
        }
        if (
          next.excludedFolderIds === undefined &&
          (next.kind === "complete" || next.expectedVersion > 0)
        ) {
          if (!(await store.saveExclusions(lease, excludedFolderIds)))
            return { kind: "paused", code: "auth" };
          read = await store.readInventory(lease);
          next = read.next;
          rate = read.rate;
          if (next.kind === "stale") return { kind: "paused", code: "auth" };
          if (next.kind === "limit")
            return { kind: "terminal", code: "unsupported" };
        }
        if (next.kind === "complete") {
          if (!(await active())) return { kind: "paused", code: "auth" };
          return delta.run(lease, control, provider);
        }
        if (!(await active())) return { kind: "paused", code: "auth" };
        if (options.remainingStatements() < OUTLOOK_STATEMENTS.inventoryPage)
          return outlookBudgetShortfall();
        const page = await provider.folders({
          ...(next.parentFolderId === null
            ? {}
            : { parentFolderId: next.parentFolderId }),
          ...(next.nextLink === null ? {} : { nextLink: next.nextLink }),
          signal: control.signal,
        });
        if (!(await active())) return { kind: "paused", code: "auth" };
        if (next.nextLink !== null && page.nextLink === next.nextLink)
          return { kind: "terminal", code: "malformed" };
        if (options.remainingStatements() < OUTLOOK_STATEMENTS.inventoryCommit)
          return outlookBudgetShortfall();
        const committed = await store.commitInventoryPage(
          lease,
          {
            parentFolderId: next.parentFolderId,
            expectedVersion: next.expectedVersion,
            nextLink: page.nextLink ?? null,
            folders: page.folders
              .filter((folder) => !excludedFolderIds.includes(folder.id))
              .map(({ id, parentFolderId, childFolderCount, isHidden }) => ({
                id,
                parentFolderId,
                childFolderCount,
                isHidden,
              })),
          },
          {
            jobId: crypto.randomUUID(),
            priority: lease.type === "sync" ? 0 : 1,
            dispatchAt: clock(),
            excludedFolderIds,
          },
        );
        if (committed.kind === "committed") return { kind: "completed" };
        if (committed.kind === "stale") return { kind: "paused", code: "auth" };
        if (committed.kind === "limit")
          return { kind: "terminal", code: "unsupported" };
        return { kind: "retry", code: "transient" };
      } catch (cause) {
        if (cause instanceof DiscoveryError) {
          if (cause.code === "AUTH_REQUIRED" || cause.code === "UNAUTHORIZED")
            return { kind: "paused", code: "auth" };
          if (cause.code === "INVALID_RANGE")
            return { kind: "terminal", code: "malformed" };
          if (cause.code === "SOURCE_UNAVAILABLE")
            return { kind: "terminal", code: "unsupported" };
          if (cause.code === "RATE_LIMITED") {
            if (!(await active()) || !rate)
              return { kind: "paused", code: "auth" };
            // One batch whether rateDecision defers or pauses (G4).
            if (options.remainingStatements() < OUTLOOK_STATEMENTS.rateDeferral)
              return outlookBudgetShortfall();
            const deferred = await store.deferRate(
              lease,
              cause.retryAfterMs,
              rate,
            );
            return deferred
              ? { kind: "completed" }
              : { kind: "paused", code: "auth" };
          }
        }
        return {
          kind: "retry",
          code: control.signal.aborted ? "timeout" : "transient",
        };
      }
    },
  };
}
