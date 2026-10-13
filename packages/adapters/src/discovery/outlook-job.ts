import type { JobLease, JobOutcome } from "@invoxim/core";
import { DiscoveryError } from "@invoxim/core";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import { createOutlookDeltaRunner } from "./outlook-delta";
import { createOutlookFolderStore } from "./outlook-state";

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
        !control.signal.aborted &&
        (await store.checkpoint(lease)) &&
        !control.signal.aborted;
      try {
        if (options.remainingStatements() < 20)
          return { kind: "paused", code: "budget" };
        if (!(await active())) return { kind: "paused", code: "auth" };
        const next = await store.getNextInventory(lease);
        if (next.kind === "stale") return { kind: "paused", code: "auth" };
        if (next.kind === "limit")
          return { kind: "terminal", code: "unsupported" };
        if (next.kind === "complete") {
          if (!(await active())) return { kind: "paused", code: "auth" };
          const provider = await options.open(lease, control.signal);
          if (!(await active())) return { kind: "paused", code: "auth" };
          return delta.run(lease, control, provider);
        }
        if (!(await active())) return { kind: "paused", code: "auth" };
        const provider = await options.open(lease, control.signal);
        if (!(await active())) return { kind: "paused", code: "auth" };
        if (options.remainingStatements() < 12)
          return { kind: "paused", code: "budget" };
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
        if (options.remainingStatements() < 9)
          return { kind: "paused", code: "budget" };
        const committed = await store.commitInventoryPage(
          lease,
          {
            parentFolderId: next.parentFolderId,
            expectedVersion: next.expectedVersion,
            nextLink: page.nextLink ?? null,
            folders: page.folders.map(
              ({ id, parentFolderId, childFolderCount, isHidden }) => ({
                id,
                parentFolderId,
                childFolderCount,
                isHidden,
              }),
            ),
          },
          {
            jobId: crypto.randomUUID(),
            priority: lease.type === "sync" ? 0 : 1,
            dispatchAt: clock(),
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
        }
        return {
          kind: "retry",
          code: control.signal.aborted ? "timeout" : "transient",
        };
      }
    },
  };
}
