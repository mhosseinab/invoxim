import {
  storageStartRequestSchema,
  storageStartResponseSchema,
} from "@invoxim/contracts";
import type {
  ArchiveAuthorizationPort,
  ArchiveCredentials,
  ArchiveSession,
  TenantContext,
} from "@invoxim/core";
import {
  ArchiveAuthorizationError,
  ArchiveServiceError,
  MailboxError,
} from "@invoxim/core";
import { z } from "zod";
import { activeProfileSql } from "../pipeline/repository-guards";
import { CredentialError } from "../security/cipher";
import { pkceVerifier, stateHash } from "../security/helpers";
import { createOAuthStateStore } from "../security/oauth-state";
import { createCredentialVault } from "../security/vault";
import {
  ARCHIVE_MAX,
  type ConnectionRow,
  createDriveConnectionsRepository,
  fields,
  liveSession,
  MAX,
  project,
  readDriveConnection,
  requireLiveDriveSession,
  sessionBindings,
} from "./connections";
import type { DriveServiceConfiguration } from "./service-types";

interface Intent {
  connection_id: string | null;
  connection_generation: number | null;
  credential_version: number | null;
  archive_settings_version: number;
}
const identitySchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(254)
    .regex(/^[\x21-\x7e]+$/),
  address: z.email().max(254),
});
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const credentialsSchema = z.object({
  accessToken: token,
  refreshToken: token.optional(),
  expiresAt: z.number().int().safe().positive(),
});
async function boundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveServiceError) throw error;
    if (error instanceof ArchiveAuthorizationError)
      throw new ArchiveServiceError(error.code);
    if (error instanceof MailboxError && error.code === "UNAUTHENTICATED")
      throw new ArchiveServiceError("UNAUTHENTICATED");
    if (error instanceof MailboxError && error.code === "RECENT_AUTH_REQUIRED")
      throw new ArchiveServiceError("RECENT_AUTH_REQUIRED");
    if (error instanceof CredentialError)
      throw new ArchiveServiceError(
        error.code === "INVALID_OAUTH_STATE"
          ? "INVALID_STATE"
          : "RECONNECT_REQUIRED",
      );
    throw new ArchiveServiceError("UNAVAILABLE");
  }
}
/** Trusted server sessions only. A grant never authorizes uploads or enables storage consent. */
export function createDriveService(
  db: D1Database,
  configuration: DriveServiceConfiguration,
  provider: ArchiveAuthorizationPort,
) {
  const states = createOAuthStateStore(db, configuration.cipher, {
    callbacks: { storage: { google: configuration.callback } },
  });
  const vault = createCredentialVault(db, configuration.cipher);
  const connections = createDriveConnectionsRepository(db);
  const live = (session: ArchiveSession) =>
    requireLiveDriveSession(db, session);
  const row = (context: TenantContext, id: string) =>
    readDriveConnection(db, context, id);
  async function start(session: ArchiveSession, connectionId?: string) {
    if (
      !storageStartRequestSchema.safeParse(
        connectionId === undefined ? {} : { connectionId },
      ).success
    )
      throw new ArchiveServiceError("INVALID_INPUT");
    await live(session);
    const existing =
      connectionId === undefined
        ? null
        : await row(session.tenant, connectionId);
    if (connectionId !== undefined && !existing)
      throw new ArchiveServiceError("NOT_FOUND");
    const setting = await db
      .prepare("SELECT version FROM archive_settings WHERE user_id=?")
      .bind(session.tenant.userId)
      .first<{ version: number }>();
    const verifier = pkceVerifier();
    const state = await states.create(session.tenant, {
      sessionId: session.sessionId,
      purpose: "storage",
      provider: "google",
      pkceVerifier: verifier,
    });
    const stored = await db
      .prepare(
        `INSERT INTO storage_oauth_intents(user_id,state_hash,connection_id,connection_generation,credential_version,archive_settings_version) SELECT ?,?,?,?,?,? WHERE ${liveSession} AND ${activeProfileSql}`,
      )
      .bind(
        session.tenant.userId,
        await stateHash(state.state),
        existing?.id ?? null,
        existing?.generation ?? null,
        existing?.credential_version ?? null,
        setting?.version ?? 0,
        ...sessionBindings(session),
        session.tenant.userId,
      )
      .run();
    if (stored.meta.changes !== 1)
      throw new ArchiveServiceError("UNAUTHENTICATED");
    const authorizationUrl = await provider.authorize({
      state: state.state,
      nonce: state.nonce,
      verifier,
      callback: configuration.callback,
    });
    await live(session);
    return storageStartResponseSchema.parse({ authorizationUrl });
  }
  async function complete(
    session: ArchiveSession,
    input: { state: string; code?: string; denied?: boolean },
  ) {
    await live(session);
    if (
      typeof input.state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.state)
    )
      throw new ArchiveServiceError("INVALID_STATE");
    const intent = await db
      .prepare(
        "SELECT connection_id,connection_generation,credential_version,archive_settings_version FROM storage_oauth_intents WHERE user_id=? AND state_hash=?",
      )
      .bind(session.tenant.userId, await stateHash(input.state))
      .first<Intent>();
    if (!intent) throw new ArchiveServiceError("INVALID_STATE");
    const state = await states.consume(session.tenant, {
      sessionId: session.sessionId,
      purpose: "storage",
      provider: "google",
      state: input.state,
      callback: configuration.callback,
    });
    if (!state) throw new ArchiveServiceError("INVALID_STATE");
    if (input.denied) throw new ArchiveServiceError("DENIED");
    if (
      typeof input.code !== "string" ||
      !input.code ||
      input.code.length > 2048
    )
      throw new ArchiveServiceError("INVALID_STATE");
    const existing =
      intent.connection_id === null
        ? null
        : await row(session.tenant, intent.connection_id);
    if (
      intent.connection_id !== null &&
      (!existing ||
        existing.generation !== intent.connection_generation ||
        existing.credential_version !== intent.credential_version)
    )
      throw new ArchiveServiceError("CONFLICT");
    if (
      existing &&
      (existing.credential_version >= MAX || existing.generation > MAX)
    )
      throw new ArchiveServiceError("CONFLICT");
    const authorization = await provider.exchange({
      code: input.code,
      verifier: state.pkceVerifier,
      nonce: state.nonce,
      callback: configuration.callback,
    });
    await live(session);
    if (authorization.canArchiveFiles !== true)
      throw new ArchiveServiceError("MISSING_PERMISSION");
    const identity = identitySchema.safeParse(authorization.identity);
    if (
      !identity.success ||
      (existing && identity.data.subject !== existing.provider_subject)
    )
      throw new ArchiveServiceError("ACCOUNT_MISMATCH");
    const parsed = credentialsSchema.safeParse(authorization.credentials);
    if (!parsed.success || parsed.data.expiresAt <= Date.now())
      throw new ArchiveServiceError("RECONNECT_REQUIRED");
    let credentials: ArchiveCredentials = {
      accessToken: parsed.data.accessToken,
      expiresAt: parsed.data.expiresAt,
      ...(parsed.data.refreshToken
        ? { refreshToken: parsed.data.refreshToken }
        : {}),
    };
    if (!credentials.refreshToken && existing?.state === "connected") {
      const previous = await vault.read(
        session.tenant,
        {
          kind: "connection",
          id: existing.id,
          generation: existing.generation,
        },
        existing.credential_version,
      );
      if (
        previous &&
        "refreshToken" in previous.secret &&
        previous.secret.refreshToken
      )
        credentials = {
          ...credentials,
          refreshToken: previous.secret.refreshToken,
        };
    }
    if (!credentials.refreshToken)
      throw new ArchiveServiceError("MISSING_REFRESH_TOKEN");
    if (!existing) {
      const duplicate = await db
        .prepare(
          "SELECT id FROM connections WHERE user_id=? AND kind='storage' AND provider='google-drive' AND provider_subject=?",
        )
        .bind(session.tenant.userId, identity.data.subject)
        .first();
      if (duplicate) throw new ArchiveServiceError("CONFLICT");
    }
    const id = existing?.id ?? crypto.randomUUID();
    const sealed = await configuration.cipher.seal(
      session.tenant,
      { entityId: id, purpose: "storage-credentials" },
      credentials,
    );
    await live(session);
    let mutation: D1PreparedStatement;
    if (existing) {
      mutation = db
        .prepare(
          `UPDATE connections SET display_address=?,scopes=?,credential_ciphertext=?,credential_key_version=?,credential_version=credential_version+1,state='connected',scheduling_state='paused',next_sync_at=NULL WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND provider_subject=? AND generation=? AND credential_version=? AND credential_version<? AND (credential_key_version IS NULL OR credential_key_version<=?) AND ${liveSession} AND ${activeProfileSql} AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=connections.user_id AND scope='connection' AND target_id=connections.id) AND NOT EXISTS(SELECT 1 FROM archive_settings a WHERE a.user_id=connections.user_id AND a.enabled=1 AND a.connection_id=connections.id AND (a.version!=? OR a.version>=?)) RETURNING ${fields}`,
        )
        .bind(
          identity.data.address,
          JSON.stringify(configuration.scopes),
          sealed,
          configuration.cipher.activeVersion,
          session.tenant.userId,
          id,
          identity.data.subject,
          existing.generation,
          existing.credential_version,
          MAX,
          configuration.cipher.activeVersion,
          ...sessionBindings(session),
          session.tenant.userId,
          intent.archive_settings_version,
          ARCHIVE_MAX,
        );
    } else {
      mutation = db
        .prepare(
          `INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state,next_sync_at) SELECT ?,?,'storage','google-drive',?,?,'connected',1,?,?,?,1,'paused',NULL WHERE ${liveSession} AND ${activeProfileSql} ON CONFLICT DO NOTHING RETURNING ${fields}`,
        )
        .bind(
          id,
          session.tenant.userId,
          identity.data.subject,
          identity.data.address,
          JSON.stringify(configuration.scopes),
          sealed,
          configuration.cipher.activeVersion,
          ...sessionBindings(session),
          session.tenant.userId,
        );
    }
    const newVersion = existing ? existing.credential_version + 1 : 1;
    const generation = existing?.generation ?? 1;
    const clearSettings = db
      .prepare(
        "UPDATE archive_settings SET enabled=0,version=version+1,connection_id=NULL,connection_generation=NULL,disclosure_version=NULL,accepted_at=NULL WHERE user_id=? AND enabled=1 AND connection_id=? AND version=? AND version<? AND EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND kind='storage' AND provider='google-drive' AND state='connected' AND generation=? AND credential_version=? AND credential_ciphertext=?)",
      )
      .bind(
        session.tenant.userId,
        id,
        intent.archive_settings_version,
        ARCHIVE_MAX,
        session.tenant.userId,
        id,
        generation,
        newVersion,
        sealed,
      );
    const results = await db.batch<ConnectionRow>([mutation, clearSettings]);
    const updated = results[0]?.results[0];
    if (!updated) throw new ArchiveServiceError("CONFLICT");
    await live(session);
    return project(updated, false);
  }
  return {
    start: (session: ArchiveSession, id?: string) =>
      boundary(() => start(session, id)),
    complete: (
      session: ArchiveSession,
      input: { state: string; code?: string; denied?: boolean },
    ) => boundary(() => complete(session, input)),
    list: (context: TenantContext) => connections.list(context),
    disconnect: (
      session: ArchiveSession,
      id: string,
      expected: { generation: number; credentialVersion: number },
    ) => connections.disconnect(session, id, expected),
  };
}
