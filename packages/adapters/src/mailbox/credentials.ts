/**
 * ext#10: the sealed-credential refresh lease lifecycle shared by mailbox
 * (mailbox/service.ts) and Drive storage (drive/refresh.ts) connections.
 * Callers own their table-specific SQL; this owns the order: acquire a fenced
 * lease or conflict, run the provider exchange under it, mark the connection
 * `needs_reconnect` on a reconnect-class failure, and always release.
 */

/** A refresh lease is held for one minute. */
export const REFRESH_LEASE_MS = 60000;
/** The provider call starts only while 45 s of the lease remain. */
export const REFRESH_MIN_REMAINING_MS = 45000;
/** Provider failures that require the owner to reconnect the account. */
export const RECONNECT_CODES: readonly string[] = [
  "RECONNECT_REQUIRED",
  "ACCOUNT_MISMATCH",
  "MISSING_PERMISSION",
];

export interface RefreshLease {
  readonly leaseId: string;
  readonly fence: number;
}

export async function refreshSealedCredential<T>(
  db: D1Database,
  steps: {
    table: "mailbox_refresh_leases" | "storage_refresh_leases";
    userId: string;
    connectionId: string;
    /** The lease upsert for `leaseId`, `RETURNING fence`. */
    acquire(leaseId: string): D1PreparedStatement;
    conflict(): Error;
    /** Checkpoint, provider refresh, seal and CAS write under the lease. */
    exchange(lease: RefreshLease): Promise<T>;
    /** True when `cause` is a reconnect-class failure (see RECONNECT_CODES). */
    reconnect(cause: unknown): boolean;
    /** The lease-guarded `needs_reconnect` update. */
    markReconnect(lease: RefreshLease): D1PreparedStatement;
  },
): Promise<T> {
  const leaseId = crypto.randomUUID();
  const acquired = await steps.acquire(leaseId).first<{ fence: number }>();
  if (!acquired) throw steps.conflict();
  const lease: RefreshLease = { leaseId, fence: acquired.fence };
  try {
    return await steps.exchange(lease);
  } catch (cause) {
    if (steps.reconnect(cause)) await steps.markReconnect(lease).run();
    throw cause;
  } finally {
    await db
      .prepare(
        `UPDATE ${steps.table} SET lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=?`,
      )
      .bind(steps.userId, steps.connectionId, leaseId, lease.fence)
      .run();
  }
}
