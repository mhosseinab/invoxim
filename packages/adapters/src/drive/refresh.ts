import {
  type StorageConnectionView,
  storageDisconnectRequestSchema,
  storageStartRequestSchema,
} from "@invoxim/contracts";
import type {
  ArchiveAuthorizationPort,
  ArchiveCredentials,
  TenantContext,
} from "@invoxim/core";
import { ArchiveAuthorizationError, ArchiveServiceError } from "@invoxim/core";
import { z } from "zod";
import { safe as keepDomainError } from "../security/helpers";
import type { CredentialCipher } from "../security/types";
import { createCredentialVault } from "../security/vault";
import {
  activeProfile,
  type ConnectionRow,
  fields,
  MAX,
  project,
} from "./connections";
import { scopesMatchConfiguration } from "./scopes";

const leaseDurationMs = 60000;
const minimumRemainingMs = 45000;
const noDeletion =
  "NOT EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=connections.user_id AND scope='connection' AND target_id=connections.id)";
const leaseClause =
  "EXISTS(SELECT 1 FROM storage_refresh_leases WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=? AND lease_expires_at>? AND connection_generation=? AND credential_version=?)";
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const credentialSchema = z.object({
  accessToken: token,
  refreshToken: token.optional(),
  expiresAt: z.number().int().safe().positive(),
});
interface RefreshRow extends ConnectionRow {
  scopes: string;
  archiving_enabled: number;
}
function credentials(
  value: unknown,
  fallbackRefresh?: string,
): ArchiveCredentials {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) throw new ArchiveServiceError("RECONNECT_REQUIRED");
  const refreshToken = parsed.data.refreshToken ?? fallbackRefresh;
  if (!refreshToken) throw new ArchiveServiceError("RECONNECT_REQUIRED");
  return {
    accessToken: parsed.data.accessToken,
    refreshToken,
    expiresAt: parsed.data.expiresAt,
  };
}
function safe<T>(operation: () => Promise<T>): Promise<T> {
  return keepDomainError(
    operation,
    (cause) =>
      cause instanceof ArchiveAuthorizationError
        ? new ArchiveServiceError(cause.code)
        : new ArchiveServiceError("UNAVAILABLE"),
    (cause) => cause instanceof ArchiveServiceError,
  );
}

/** Provider refresh must verify its account/scopes and enforce per-request authorization at composition. */
export function createDriveCredentialRefresher(
  db: D1Database,
  cipher: CredentialCipher,
  provider: ArchiveAuthorizationPort,
) {
  const vault = createCredentialVault(db, cipher);
  async function row(context: TenantContext, id: string) {
    return db
      .prepare(
        `SELECT ${fields},scopes,EXISTS(SELECT 1 FROM archive_settings a WHERE a.user_id=connections.user_id AND a.enabled=1 AND a.connection_id=connections.id AND a.connection_generation=connections.generation) AS archiving_enabled FROM connections WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND ${activeProfile} AND ${noDeletion}`,
      )
      .bind(context.userId, id, context.userId)
      .first<RefreshRow>();
  }
  async function refresh(
    context: TenantContext,
    id: string,
    expected: { generation: number; credentialVersion: number },
  ): Promise<StorageConnectionView> {
    if (
      !storageStartRequestSchema.safeParse({ connectionId: id }).success ||
      !storageDisconnectRequestSchema.safeParse(expected).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    const existing = await row(context, id);
    if (existing?.state !== "connected")
      throw new ArchiveServiceError("RECONNECT_REQUIRED");
    if (
      existing.generation !== expected.generation ||
      existing.credential_version !== expected.credentialVersion ||
      existing.credential_version >= MAX
    )
      throw new ArchiveServiceError("CONFLICT");
    if (!scopesMatchConfiguration(existing.scopes))
      throw new ArchiveServiceError("MISSING_PERMISSION");
    const snapshot = await vault.read(
      context,
      { kind: "connection", id, generation: existing.generation },
      existing.credential_version,
    );
    if (!snapshot || snapshot.keyVersion > cipher.activeVersion)
      throw new ArchiveServiceError("RECONNECT_REQUIRED");
    const current = credentials(snapshot.secret);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX - leaseDurationMs)
      throw new ArchiveServiceError("UNAVAILABLE");
    const leaseId = crypto.randomUUID();
    const lease = await db
      .prepare(
        `INSERT INTO storage_refresh_leases(user_id,connection_id,lease_id,lease_expires_at,connection_generation,credential_version,fence) SELECT ?,?,?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND state='connected' AND generation=? AND credential_version=? AND provider_subject=? AND scopes=? AND ${activeProfile} AND ${noDeletion}) ON CONFLICT(user_id,connection_id) DO UPDATE SET lease_id=excluded.lease_id,lease_expires_at=excluded.lease_expires_at,connection_generation=excluded.connection_generation,credential_version=excluded.credential_version,fence=storage_refresh_leases.fence+1 WHERE storage_refresh_leases.lease_expires_at<=? AND storage_refresh_leases.fence<? RETURNING fence`,
      )
      .bind(
        context.userId,
        id,
        leaseId,
        now + leaseDurationMs,
        existing.generation,
        existing.credential_version,
        context.userId,
        id,
        existing.generation,
        existing.credential_version,
        existing.provider_subject,
        existing.scopes,
        context.userId,
        now,
        MAX,
      )
      .first<{ fence: number }>();
    if (!lease) throw new ArchiveServiceError("CONFLICT");
    const leaseBindings = (time = Date.now()) => [
      context.userId,
      id,
      leaseId,
      lease.fence,
      time,
      existing.generation,
      existing.credential_version,
    ];
    try {
      const checkpoint = await db
        .prepare(
          `SELECT fence FROM storage_refresh_leases WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=? AND lease_expires_at>? AND connection_generation=? AND credential_version=? AND EXISTS(SELECT 1 FROM connections WHERE user_id=storage_refresh_leases.user_id AND id=storage_refresh_leases.connection_id AND kind='storage' AND provider='google-drive' AND state='connected' AND generation=storage_refresh_leases.connection_generation AND credential_version=storage_refresh_leases.credential_version AND provider_subject=? AND scopes=? AND ${activeProfile} AND ${noDeletion})`,
        )
        .bind(
          ...leaseBindings(Date.now() + minimumRemainingMs),
          existing.provider_subject,
          existing.scopes,
          context.userId,
        )
        .first();
      if (!checkpoint) throw new ArchiveServiceError("CONFLICT");
      const result = credentials(
        await provider.refresh(current, {
          subject: existing.provider_subject,
          address: existing.display_address,
        }),
        current.refreshToken,
      );
      if (result.expiresAt <= Date.now())
        throw new ArchiveServiceError("RECONNECT_REQUIRED");
      const sealed = await cipher.seal(
        context,
        { entityId: id, purpose: "storage-credentials" },
        result,
      );
      const changed = await db
        .prepare(
          `UPDATE connections SET credential_ciphertext=?,credential_key_version=?,credential_version=credential_version+1 WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND state='connected' AND generation=? AND credential_version=? AND provider_subject=? AND scopes=? AND credential_version<? AND credential_key_version<=? AND ${leaseClause} AND ${activeProfile} AND ${noDeletion} RETURNING ${fields}`,
        )
        .bind(
          sealed,
          cipher.activeVersion,
          context.userId,
          id,
          existing.generation,
          existing.credential_version,
          existing.provider_subject,
          existing.scopes,
          MAX,
          cipher.activeVersion,
          ...leaseBindings(),
          context.userId,
        )
        .first<ConnectionRow>();
      if (!changed) throw new ArchiveServiceError("CONFLICT");
      const updated = await row(context, id);
      if (
        updated?.state !== "connected" ||
        updated.provider_subject !== existing.provider_subject ||
        updated.scopes !== existing.scopes ||
        updated.generation !== existing.generation ||
        updated.credential_version !== existing.credential_version + 1 ||
        updated.credential_ciphertext !== sealed
      )
        throw new ArchiveServiceError("CONFLICT");
      return project(updated);
    } catch (error) {
      if (
        (error instanceof ArchiveAuthorizationError ||
          error instanceof ArchiveServiceError) &&
        [
          "RECONNECT_REQUIRED",
          "ACCOUNT_MISMATCH",
          "MISSING_PERMISSION",
        ].includes(error.code)
      ) {
        await db
          .prepare(
            `UPDATE connections SET state='needs_reconnect',scheduling_state='paused',next_sync_at=NULL WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND state='connected' AND generation=? AND credential_version=? AND provider_subject=? AND scopes=? AND ${leaseClause} AND ${activeProfile} AND ${noDeletion}`,
          )
          .bind(
            context.userId,
            id,
            existing.generation,
            existing.credential_version,
            existing.provider_subject,
            existing.scopes,
            ...leaseBindings(),
            context.userId,
          )
          .run();
      }
      throw error;
    } finally {
      await db
        .prepare(
          "UPDATE storage_refresh_leases SET lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=?",
        )
        .bind(context.userId, id, leaseId, lease.fence)
        .run();
    }
  }
  return {
    refresh: (
      context: TenantContext,
      id: string,
      expected: { generation: number; credentialVersion: number },
    ) => safe(() => refresh(context, id, expected)),
  };
}
