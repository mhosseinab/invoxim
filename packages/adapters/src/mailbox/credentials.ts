import type { TenantContext } from "@invoxim/core";
import { z } from "zod";
import { activeProfileSql } from "../pipeline/repository-guards";
import type { CredentialSnapshot } from "../security/types";
import { validateOutlookReadScopes } from "./outlook";

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

/** G9: one access-token expiry skew for every provider factory. */
export const CREDENTIAL_REFRESH_SKEW_MS = 30000;

function access(snapshot: CredentialSnapshot | null) {
  if (
    !snapshot ||
    !("accessToken" in snapshot.secret) ||
    !snapshot.secret.accessToken ||
    !snapshot.secret.expiresAt
  )
    return undefined;
  return {
    accessToken: snapshot.secret.accessToken,
    expiresAt: snapshot.secret.expiresAt,
    version: snapshot.version,
  };
}

/**
 * G9: the one credential open/refresh path for the provider factories. Reads
 * the sealed access token, refreshes once when it expires within
 * CREDENTIAL_REFRESH_SKEW_MS, rereads, and requires a token still outside the
 * skew. Callers supply their reads, refresh and abort checkpoints; `fail`
 * builds their auth-required error.
 */
export async function openMailboxCredential(steps: {
  read(): Promise<CredentialSnapshot | null>;
  refresh(): Promise<void>;
  /** Runs before the final freshness check (abort checkpoints). */
  settled?(): void;
  fail(): Error;
}): Promise<{ accessToken: string; version: number }> {
  let snapshot = await steps.read();
  const initial = access(snapshot);
  if (!initial) throw steps.fail();
  if (initial.expiresAt <= Date.now() + CREDENTIAL_REFRESH_SKEW_MS) {
    await steps.refresh();
    snapshot = await steps.read();
  }
  steps.settled?.();
  const fresh = access(snapshot);
  if (!fresh || fresh.expiresAt <= Date.now() + CREDENTIAL_REFRESH_SKEW_MS)
    throw steps.fail();
  return { accessToken: fresh.accessToken, version: fresh.version };
}

/**
 * ext#11: the one "Outlook connection is still connected with read-only mail
 * scopes" check. `checkpoint` runs right after the lookup; `fail` builds the
 * caller's auth-required error. Scope violations throw MailboxError
 * MISSING_PERMISSION from validateOutlookReadScopes.
 */
export async function requireOutlookConnection(
  db: D1Database,
  context: TenantContext,
  connection: { connectionId: string; generation: number },
  fail: () => Error,
  checkpoint?: () => void,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id,scopes FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider='outlook' AND state='connected' AND generation=? AND ${activeProfileSql}`,
    )
    .bind(
      context.userId,
      connection.connectionId,
      connection.generation,
      context.userId,
    )
    .first<{ id: string; scopes: string }>();
  checkpoint?.();
  if (!row) throw fail();
  let scopes: string[];
  try {
    scopes = z.array(z.string()).parse(JSON.parse(row.scopes));
  } catch {
    throw fail();
  }
  validateOutlookReadScopes(scopes.join(" "), true);
}
