import type { JobLease } from "@invoxim/core";
import type { OutlookGraphDiscoveryPort } from "./outlook";
import { createOutlookFolderStore } from "./outlook-state";

export interface OutlookInventoryControl {
  signal: AbortSignal;
  checkpoint: () => Promise<boolean>;
}
export type OutlookInventoryOutcome = {
  kind:
    | "progressed"
    | "inventory-complete"
    | "stale"
    | "limit"
    | "budget"
    | "cursor-loop"
    | "conflict";
};
export interface OutlookInventoryOptions {
  open: (
    lease: JobLease,
    control: OutlookInventoryControl,
  ) => Promise<OutlookGraphDiscoveryPort>;
  remainingStatements: () => number;
}
/** One resumable folder page; completing inventory never claims message coverage. */
export function createOutlookInventoryCoordinator(
  db: D1Database,
  options: OutlookInventoryOptions,
) {
  const store = createOutlookFolderStore(db);
  async function current(lease: JobLease, control: OutlookInventoryControl) {
    if (
      control.signal.aborted ||
      !(await control.checkpoint()) ||
      control.signal.aborted
    )
      return false;
    return (await store.checkpoint(lease)) && !control.signal.aborted;
  }
  return {
    async runPage(
      lease: JobLease,
      control: OutlookInventoryControl,
    ): Promise<OutlookInventoryOutcome> {
      if (control.signal.aborted) return { kind: "stale" };
      // Inventory read, guarded commit and caller settlement must share one physical meter.
      if (options.remainingStatements() < 20) return { kind: "budget" };
      if (!(await control.checkpoint()) || control.signal.aborted)
        return { kind: "stale" };
      const next = await store.getNextInventory(lease);
      if (next.kind === "complete") return { kind: "inventory-complete" };
      if (next.kind !== "ready") return { kind: next.kind };
      if (!(await current(lease, control))) return { kind: "stale" };
      const provider = await options.open(lease, control);
      if (!(await current(lease, control))) return { kind: "stale" };
      // Leave room for post-response checks, the entire atomic page commit and settlement.
      if (options.remainingStatements() < 12) return { kind: "budget" };
      const page = await provider.folders({
        ...(next.parentFolderId === null
          ? {}
          : { parentFolderId: next.parentFolderId }),
        ...(next.nextLink === null ? {} : { nextLink: next.nextLink }),
        signal: control.signal,
      });
      if (!(await current(lease, control))) return { kind: "stale" };
      if (next.nextLink !== null && page.nextLink === next.nextLink)
        return { kind: "cursor-loop" };
      if (options.remainingStatements() < 9) return { kind: "budget" };
      const committed = await store.commitInventoryPage(lease, {
        parentFolderId: next.parentFolderId,
        expectedVersion: next.expectedVersion,
        nextLink: page.nextLink ?? null,
        // Folder display names are neither necessary nor retained.
        folders: page.folders.map(
          ({ id, parentFolderId, childFolderCount, isHidden }) => ({
            id,
            parentFolderId,
            childFolderCount,
            isHidden,
          }),
        ),
      });
      return {
        kind: committed.kind === "committed" ? "progressed" : committed.kind,
      };
    },
  };
}
