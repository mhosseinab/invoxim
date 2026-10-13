import {
  type ArchiveEnableRequest,
  type ArchiveSettingsView,
  archiveDisableRequestSchema,
  archiveEnableRequestSchema,
  archiveSettingsViewSchema,
} from "@invoxim/contracts";
import {
  ArchiveServiceError,
  type ArchiveSession,
  type TenantContext,
} from "@invoxim/core";
export type ArchiveConsentView = ArchiveSettingsView;
export type ArchiveEnableInput = ArchiveEnableRequest;
const archiveMaximumVersion = 2147483646;
const recentMs = 3600000;
interface SettingsRow {
  enabled: number | null;
  version: number | null;
  connection_id: string | null;
  connection_generation: number | null;
  disclosure_version: number | null;
  accepted_at: number | null;
}
function disabled(version = 0): ArchiveSettingsView {
  return {
    enabled: false,
    version,
    connectionId: null,
    generation: null,
    disclosureVersion: null,
    acceptedAt: null,
  };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveServiceError) throw error;
    throw new ArchiveServiceError("UNAVAILABLE");
  }
}
const sessionGuard =
  "EXISTS(SELECT 1 FROM session se JOIN profiles p ON p.user_id=se.userId WHERE se.id=? AND se.userId=? AND se.expiresAt>? AND typeof(se.createdAt)='integer' AND se.createdAt<=? AND se.createdAt>=? AND p.status='active')";
const drivePermission =
  "json_type(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END)='array' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.scopes) THEN c.scopes ELSE '[]' END) permission WHERE permission.type='text' AND permission.value='https://www.googleapis.com/auth/drive.file')";
const destinationGuard = `EXISTS(SELECT 1 FROM connections c WHERE c.user_id=? AND c.id=? AND c.kind='storage' AND c.provider='google-drive' AND c.state='connected' AND c.generation=? AND c.credential_ciphertext IS NOT NULL AND c.credential_key_version IS NOT NULL AND c.credential_key_version>0 AND ${drivePermission})`;
export function createArchiveConsentRepository(
  db: D1Database,
  options: { clock?: () => number } = {},
) {
  const clock = options.clock ?? Date.now;
  function currentTime(): number {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new ArchiveServiceError("UNAVAILABLE");
    return now;
  }
  function sessionArguments(session: ArchiveSession, now: number) {
    return [
      session.sessionId,
      session.tenant.userId,
      now,
      now,
      Math.max(0, now - recentMs),
    ];
  }
  async function live(session: ArchiveSession): Promise<void> {
    if (session.tenant.authority !== "session")
      throw new ArchiveServiceError("UNAUTHENTICATED");
    const now = currentTime();
    const row = await db
      .prepare(
        "SELECT se.createdAt FROM session se JOIN profiles p ON p.user_id=se.userId WHERE se.id=? AND se.userId=? AND se.expiresAt>? AND p.status='active'",
      )
      .bind(session.sessionId, session.tenant.userId, now)
      .first<{ createdAt: number }>();
    if (!row) throw new ArchiveServiceError("UNAUTHENTICATED");
    if (
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt > now ||
      now - row.createdAt > recentMs
    )
      throw new ArchiveServiceError("RECENT_AUTH_REQUIRED");
  }
  async function destination(
    session: ArchiveSession,
    input: ArchiveEnableRequest,
  ): Promise<void> {
    const row = await db
      .prepare(`SELECT ${destinationGuard} AS ready`)
      .bind(session.tenant.userId, input.connectionId, input.expectedGeneration)
      .first<{ ready: number }>();
    if (row?.ready !== 1) throw new ArchiveServiceError("NOT_FOUND");
  }
  async function read(context: TenantContext): Promise<ArchiveSettingsView> {
    const row = await db
      .prepare(
        "SELECT s.enabled,s.version,s.connection_id,s.connection_generation,s.disclosure_version,s.accepted_at FROM profiles p LEFT JOIN archive_settings s ON s.user_id=p.user_id WHERE p.user_id=? AND p.status='active'",
      )
      .bind(context.userId)
      .first<SettingsRow>();
    if (!row) throw new ArchiveServiceError("UNAUTHENTICATED");
    if (row.version === null) return disabled();
    const view =
      row.enabled === 0
        ? disabled(row.version)
        : {
            enabled: true,
            version: row.version,
            connectionId: row.connection_id,
            generation: row.connection_generation,
            disclosureVersion: row.disclosure_version,
            acceptedAt: row.accepted_at,
          };
    const parsed = archiveSettingsViewSchema.safeParse(view);
    if (!parsed.success) throw new ArchiveServiceError("UNAVAILABLE");
    return parsed.data;
  }
  async function enable(
    session: ArchiveSession,
    value: ArchiveEnableRequest,
  ): Promise<ArchiveSettingsView> {
    const parsed = archiveEnableRequestSchema.safeParse(value);
    if (!parsed.success) throw new ArchiveServiceError("INVALID_INPUT");
    const input = parsed.data;
    if (input.expectedVersion >= archiveMaximumVersion)
      throw new ArchiveServiceError("CONFLICT");
    await live(session);
    await destination(session, input);
    const now = currentTime(),
      nextVersion = input.expectedVersion + 1;
    const result = await db
      .prepare(
        `INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) SELECT ?,1,?,?,?,?,? WHERE ${sessionGuard} AND ${destinationGuard} AND COALESCE((SELECT version FROM archive_settings WHERE user_id=?),0)=? ON CONFLICT(user_id) DO UPDATE SET enabled=1,version=excluded.version,connection_id=excluded.connection_id,connection_generation=excluded.connection_generation,disclosure_version=excluded.disclosure_version,accepted_at=excluded.accepted_at WHERE archive_settings.version=?`,
      )
      .bind(
        session.tenant.userId,
        nextVersion,
        input.connectionId,
        input.expectedGeneration,
        input.disclosureVersion,
        now,
        ...sessionArguments(session, now),
        session.tenant.userId,
        input.connectionId,
        input.expectedGeneration,
        session.tenant.userId,
        input.expectedVersion,
        input.expectedVersion,
      )
      .run();
    if (result.meta.changes !== 1) {
      await live(session);
      await destination(session, input);
      throw new ArchiveServiceError("CONFLICT");
    }
    return {
      enabled: true,
      version: nextVersion,
      connectionId: input.connectionId,
      generation: input.expectedGeneration,
      disclosureVersion: input.disclosureVersion,
      acceptedAt: now,
    };
  }
  async function disable(
    session: ArchiveSession,
    value: { expectedVersion: number },
  ): Promise<ArchiveSettingsView> {
    const parsed = archiveDisableRequestSchema.safeParse(value);
    if (!parsed.success) throw new ArchiveServiceError("INVALID_INPUT");
    const input = parsed.data;
    if (input.expectedVersion >= archiveMaximumVersion)
      throw new ArchiveServiceError("CONFLICT");
    await live(session);
    const now = currentTime(),
      nextVersion = input.expectedVersion + 1;
    const result = await db
      .prepare(
        `INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) SELECT ?,0,?,NULL,NULL,NULL,NULL WHERE ${sessionGuard} AND COALESCE((SELECT version FROM archive_settings WHERE user_id=?),0)=? ON CONFLICT(user_id) DO UPDATE SET enabled=0,version=excluded.version,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE archive_settings.version=?`,
      )
      .bind(
        session.tenant.userId,
        nextVersion,
        ...sessionArguments(session, now),
        session.tenant.userId,
        input.expectedVersion,
        input.expectedVersion,
      )
      .run();
    if (result.meta.changes !== 1) {
      await live(session);
      throw new ArchiveServiceError("CONFLICT");
    }
    return disabled(nextVersion);
  }
  return {
    read: (context: TenantContext) => safe(() => read(context)),
    enable: (session: ArchiveSession, input: ArchiveEnableRequest) =>
      safe(() => enable(session, input)),
    disable: (session: ArchiveSession, input: { expectedVersion: number }) =>
      safe(() => disable(session, input)),
  };
}
