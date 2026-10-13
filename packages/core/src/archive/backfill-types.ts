import type { TenantContext } from "../tenant-context";
import type { ArchiveSession } from "./service-types";

export interface ArchiveBackfillSelection {
  connectionId: string;
  generation: number;
  settingsVersion: number;
}
export interface ArchiveBackfillView extends ArchiveBackfillSelection {
  id: string;
  snapshotCount: number;
  cursorOrdinal: number;
  hasMore: boolean;
  state: "pending" | "admission_complete" | "canceled";
  revision: number;
}
export interface ArchiveBackfillLease {
  context: TenantContext;
  runId: string;
  leaseId: string;
  fence: number;
  expiresAt: number;
  revision: number;
  cursorOrdinal: number;
}
export interface ArchiveBackfillPage {
  admitted: number;
  skipped: number;
  cursorOrdinal: number;
  done: boolean;
}
export interface ArchiveBackfillStore {
  start(
    session: ArchiveSession,
    selection: ArchiveBackfillSelection,
  ): Promise<ArchiveBackfillView>;
  read(context: TenantContext, runId: string): Promise<ArchiveBackfillView>;
  claim(
    context: TenantContext,
    runId: string,
  ): Promise<ArchiveBackfillLease | null>;
  admitPage(lease: ArchiveBackfillLease): Promise<ArchiveBackfillPage>;
  cancel(
    session: ArchiveSession,
    runId: string,
    revision: number,
  ): Promise<ArchiveBackfillView>;
}
