import { mailboxConnectionViewSchema } from "@invoxim/contracts";
import type {
  MailboxAuthorizationPort,
  MailboxCredentials,
  MailboxSession,
  TenantContext,
} from "@invoxim/core";
import {
  authorizeMailboxCredentials,
  MailboxError,
  requireRecentMailboxSession,
} from "@invoxim/core";
import { activeProfile, activeProfileSql } from "../pipeline/repository-guards";
import { stateHash } from "../security/helpers";
import { createOAuthStateStore } from "../security/oauth-state";
import { createCredentialVault } from "../security/vault";
import type { MailboxServiceConfiguration } from "./types";

interface ConnectionRow {
  id: string;
  provider: "gmail" | "outlook";
  provider_subject: string;
  display_address: string;
  state: "connected" | "needs_reconnect" | "disconnected";
  scheduling_state: "awaiting_import" | "active" | "paused";
  generation: number;
  credential_version: number;
  credential_key_version: number | null;
  credential_ciphertext: string | null;
}
interface Intent {
  connection_id: string | null;
  connection_generation: number | null;
  credential_version: number | null;
}
const MAX = Number.MAX_SAFE_INTEGER;
const fields =
  "id,provider,provider_subject,display_address,state,scheduling_state,generation,credential_version,credential_key_version,credential_ciphertext";
function verifier() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function project(row: ConnectionRow) {
  return mailboxConnectionViewSchema.parse({
    id: row.id,
    provider: row.provider,
    kind: "mailbox",
    address: row.display_address,
    state: row.state,
    schedulingState: row.scheduling_state,
    generation: row.generation,
    credentialVersion: row.credential_version,
    configured: row.state === "connected" && row.credential_ciphertext !== null,
  });
}
/** Trusted session/job contexts only; provider transport must verify credential ownership. */
export function createMailboxService(
  db: D1Database,
  configuration: MailboxServiceConfiguration,
  provider: MailboxAuthorizationPort,
  options: {
    canResume?: (
      context: TenantContext,
      connectionId: string,
    ) => Promise<boolean>;
  } = {},
) {
  const states = createOAuthStateStore(db, configuration.cipher, {
    callbacks: {
      mailbox: { [configuration.oauthProvider]: configuration.callback },
    },
  });
  const vault = createCredentialVault(db, configuration.cipher);
  const management = createMailboxManagement(db, configuration.provider);
  async function row(context: TenantContext, id: string) {
    return db
      .prepare(
        `SELECT ${fields} FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider=? AND ${activeProfileSql}`,
      )
      .bind(context.userId, id, configuration.provider, context.userId)
      .first<ConnectionRow>();
  }
  async function start(session: MailboxSession, connectionId?: string) {
    requireRecentMailboxSession(session, Date.now());
    await liveMailboxSession(db, session);
    const existing = connectionId
      ? await row(session.tenant, connectionId)
      : null;
    if (connectionId && !existing) throw new MailboxError("NOT_FOUND");
    const pkceVerifier = verifier();
    const state = await states.create(session.tenant, {
      sessionId: session.sessionId,
      purpose: "mailbox",
      provider: configuration.oauthProvider,
      pkceVerifier,
    });
    await db
      .prepare(
        "INSERT INTO mailbox_oauth_intents(user_id,state_hash,connection_id,connection_generation,credential_version) VALUES(?,?,?,?,?)",
      )
      .bind(
        session.tenant.userId,
        await stateHash(state.state),
        existing?.id ?? null,
        existing?.generation ?? null,
        existing?.credential_version ?? null,
      )
      .run();
    return {
      authorizationUrl: await provider.authorize({
        state: state.state,
        nonce: state.nonce,
        verifier: pkceVerifier,
        callback: configuration.callback,
      }),
    };
  }
  async function complete(
    session: MailboxSession,
    input: { state: string; code?: string; denied?: boolean },
  ) {
    requireRecentMailboxSession(session, Date.now());
    await liveMailboxSession(db, session);
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state))
      throw new MailboxError("INVALID_STATE");
    const intent = await db
      .prepare(
        "SELECT connection_id,connection_generation,credential_version FROM mailbox_oauth_intents WHERE user_id=? AND state_hash=?",
      )
      .bind(session.tenant.userId, await stateHash(input.state))
      .first<Intent>();
    if (!intent) throw new MailboxError("INVALID_STATE");
    const state = await states.consume(session.tenant, {
      sessionId: session.sessionId,
      purpose: "mailbox",
      provider: configuration.oauthProvider,
      state: input.state,
      callback: configuration.callback,
    });
    if (!state) throw new MailboxError("INVALID_STATE");
    if (input.denied) throw new MailboxError("DENIED");
    if (!input.code || input.code.length > 2048)
      throw new MailboxError("INVALID_STATE");
    let existing = intent.connection_id
      ? await row(session.tenant, intent.connection_id)
      : null;
    if (
      intent.connection_id &&
      (!existing ||
        existing.generation !== intent.connection_generation ||
        existing.credential_version !== intent.credential_version)
    )
      throw new MailboxError("CONFLICT");
    const authorization = await provider.exchange({
      code: input.code,
      verifier: state.pkceVerifier,
      nonce: state.nonce,
      callback: configuration.callback,
    });
    if (!existing) {
      existing = await db
        .prepare(
          `SELECT ${fields} FROM connections WHERE user_id=? AND kind='mailbox' AND provider=? AND provider_subject=?`,
        )
        .bind(
          session.tenant.userId,
          configuration.provider,
          authorization.identity.subject,
        )
        .first<ConnectionRow>();
    }
    let retained: string | undefined;
    if (
      existing &&
      existing.state === "connected" &&
      existing.provider_subject === authorization.identity.subject
    ) {
      const snapshot = await vault.read(
        session.tenant,
        {
          kind: "connection",
          id: existing.id,
          generation: existing.generation,
        },
        existing.credential_version,
      );
      if (snapshot && "refreshToken" in snapshot.secret)
        retained = snapshot.secret.refreshToken;
    }
    const authorized = authorizeMailboxCredentials(
      authorization,
      existing
        ? {
            subject: existing.provider_subject,
            ...(retained ? { refreshToken: retained } : {}),
          }
        : undefined,
    );
    const credentials = authorized.credentials;
    const id = existing?.id ?? crypto.randomUUID();
    const sealed = await configuration.cipher.seal(
      session.tenant,
      { entityId: id, purpose: "mailbox-credentials" },
      credentials,
    );
    await liveMailboxSession(db, session);
    const scopes = JSON.stringify(configuration.scopes);
    let updated: ConnectionRow | null;
    if (existing) {
      const scheduling =
        existing.scheduling_state === "awaiting_import"
          ? "awaiting_import"
          : options.canResume && (await options.canResume(session.tenant, id))
            ? "active"
            : "paused";
      updated = await db
        .prepare(
          `UPDATE connections SET display_address=?,scopes=?,credential_ciphertext=?,credential_key_version=?,credential_version=credential_version+1,state='connected',scheduling_state=?,next_sync_at=? WHERE user_id=? AND id=? AND generation=? AND credential_version=? AND credential_version<? AND (credential_key_version IS NULL OR credential_key_version<=?) AND (state!='disconnected' OR (SELECT COUNT(*) FROM connections WHERE user_id=? AND kind='mailbox' AND state!='disconnected')<?) AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?) AND ${activeProfileSql} AND (?!='active' OR EXISTS(SELECT 1 FROM processing_consents WHERE user_id=? AND connection_id=? AND revoked_at IS NULL AND background_authorized=1)) AND NOT EXISTS(SELECT 1 FROM lifecycle_deletions WHERE user_id=connections.user_id AND scope='connection' AND target_id=connections.id) RETURNING ${fields}`,
        )
        .bind(
          authorization.identity.address,
          scopes,
          sealed,
          configuration.cipher.activeVersion,
          scheduling,
          scheduling === "active" ? Date.now() : null,
          session.tenant.userId,
          id,
          existing.generation,
          existing.credential_version,
          MAX,
          configuration.cipher.activeVersion,
          session.tenant.userId,
          configuration.limit,
          session.sessionId,
          session.tenant.userId,
          Date.now(),
          session.tenant.userId,
          scheduling,
          session.tenant.userId,
          id,
        )
        .first<ConnectionRow>();
    } else {
      updated = await db
        .prepare(
          `INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) SELECT ?,?,'mailbox',?,?,?,'connected',1,?,?,?,1,'awaiting_import' WHERE ${activeProfileSql} AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?) AND (SELECT COUNT(*) FROM connections WHERE user_id=? AND kind='mailbox' AND state!='disconnected')<? ON CONFLICT DO NOTHING RETURNING ${fields}`,
        )
        .bind(
          id,
          session.tenant.userId,
          configuration.provider,
          authorization.identity.subject,
          authorization.identity.address,
          scopes,
          sealed,
          configuration.cipher.activeVersion,
          session.tenant.userId,
          session.sessionId,
          session.tenant.userId,
          Date.now(),
          session.tenant.userId,
          configuration.limit,
        )
        .first<ConnectionRow>();
    }
    if (!updated)
      throw new MailboxError(
        existing && existing.state !== "disconnected"
          ? "CONFLICT"
          : "LIMIT_REACHED",
      );
    return project(updated);
  }
  async function refresh(
    context: TenantContext,
    id: string,
    expectedGeneration?: number,
    expectedCredentialVersion?: number,
  ) {
    const existing = await row(context, id);
    if (
      existing?.state !== "connected" ||
      (expectedGeneration !== undefined &&
        existing.generation !== expectedGeneration)
    )
      throw new MailboxError("RECONNECT_REQUIRED");
    if (
      expectedCredentialVersion !== undefined &&
      existing.credential_version !== expectedCredentialVersion
    )
      throw new MailboxError("CONFLICT");
    const snapshot = await vault.read(
      context,
      { kind: "connection", id, generation: existing.generation },
      existing.credential_version,
    );
    if (
      !snapshot ||
      !("accessToken" in snapshot.secret) ||
      !snapshot.secret.accessToken ||
      !snapshot.secret.expiresAt ||
      snapshot.keyVersion > configuration.cipher.activeVersion
    )
      throw new MailboxError("RECONNECT_REQUIRED");
    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const lease = await db
      .prepare(
        "INSERT INTO mailbox_refresh_leases(user_id,connection_id,lease_id,lease_expires_at,connection_generation,credential_version,fence) SELECT ?,?,?,?,?,?,1 WHERE EXISTS(SELECT 1 FROM connections WHERE user_id=? AND id=? AND state='connected' AND generation=? AND credential_version=?) ON CONFLICT(user_id,connection_id) DO UPDATE SET lease_id=excluded.lease_id,lease_expires_at=excluded.lease_expires_at,connection_generation=excluded.connection_generation,credential_version=excluded.credential_version,fence=mailbox_refresh_leases.fence+1 WHERE mailbox_refresh_leases.lease_expires_at<=? AND mailbox_refresh_leases.fence<? RETURNING fence",
      )
      .bind(
        context.userId,
        id,
        leaseId,
        now + 60000,
        existing.generation,
        existing.credential_version,
        context.userId,
        id,
        existing.generation,
        existing.credential_version,
        now,
        MAX,
      )
      .first<{ fence: number }>();
    if (!lease) throw new MailboxError("CONFLICT");
    const leaseClause =
      "EXISTS(SELECT 1 FROM mailbox_refresh_leases WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=? AND lease_expires_at>?)";
    try {
      const latest = await row(context, id);
      if (
        latest?.state !== "connected" ||
        latest.generation !== existing.generation ||
        latest.credential_version !== existing.credential_version
      )
        throw new MailboxError("CONFLICT");
      const current: MailboxCredentials = {
        accessToken: snapshot.secret.accessToken,
        expiresAt: snapshot.secret.expiresAt,
        ...(snapshot.secret.refreshToken
          ? { refreshToken: snapshot.secret.refreshToken }
          : {}),
      };
      const checkpoint = await db
        .prepare(
          `SELECT fence FROM mailbox_refresh_leases WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=? AND lease_expires_at>? AND connection_generation=? AND credential_version=? AND EXISTS(SELECT 1 FROM connections WHERE user_id=mailbox_refresh_leases.user_id AND id=mailbox_refresh_leases.connection_id AND state='connected' AND generation=mailbox_refresh_leases.connection_generation AND credential_version=mailbox_refresh_leases.credential_version) AND ${activeProfile("mailbox_refresh_leases")}`,
        )
        .bind(
          context.userId,
          id,
          leaseId,
          lease.fence,
          Date.now() + 45000,
          existing.generation,
          existing.credential_version,
        )
        .first();
      if (!checkpoint) throw new MailboxError("CONFLICT");
      const credentials = await provider.refresh(current, {
        subject: existing.provider_subject,
        address: existing.display_address,
      });
      const sealed = await configuration.cipher.seal(
        context,
        { entityId: id, purpose: "mailbox-credentials" },
        credentials,
      );
      const changed = await db
        .prepare(
          `UPDATE connections SET credential_ciphertext=?,credential_key_version=?,credential_version=credential_version+1 WHERE user_id=? AND id=? AND state='connected' AND generation=? AND credential_version=? AND credential_version<? AND credential_key_version<=? AND ${leaseClause} AND ${activeProfileSql} RETURNING ${fields}`,
        )
        .bind(
          sealed,
          configuration.cipher.activeVersion,
          context.userId,
          id,
          existing.generation,
          existing.credential_version,
          MAX,
          configuration.cipher.activeVersion,
          context.userId,
          id,
          leaseId,
          lease.fence,
          Date.now(),
          context.userId,
        )
        .first<ConnectionRow>();
      if (!changed) throw new MailboxError("CONFLICT");
      return project(changed);
    } catch (cause) {
      if (
        cause instanceof MailboxError &&
        [
          "RECONNECT_REQUIRED",
          "ACCOUNT_MISMATCH",
          "MISSING_PERMISSION",
        ].includes(cause.code)
      ) {
        await db
          .prepare(
            `UPDATE connections SET state='needs_reconnect',scheduling_state='paused',next_sync_at=NULL WHERE user_id=? AND id=? AND state='connected' AND generation=? AND credential_version=? AND ${leaseClause}`,
          )
          .bind(
            context.userId,
            id,
            existing.generation,
            existing.credential_version,
            context.userId,
            id,
            leaseId,
            lease.fence,
            Date.now(),
          )
          .run();
      }
      throw cause;
    } finally {
      await db
        .prepare(
          "UPDATE mailbox_refresh_leases SET lease_id=NULL,lease_expires_at=0 WHERE user_id=? AND connection_id=? AND lease_id=? AND fence=?",
        )
        .bind(context.userId, id, leaseId, lease.fence)
        .run();
    }
  }
  return {
    start: (...args: Parameters<typeof start>) => safe(() => start(...args)),
    complete: (...args: Parameters<typeof complete>) =>
      safe(() => complete(...args)),
    list: management.list,
    disconnect: management.disconnect,
    refresh: (...args: Parameters<typeof refresh>) =>
      safe(() => refresh(...args)),
  };
}

async function liveMailboxSession(db: D1Database, session: MailboxSession) {
  const found = await db
    .prepare(
      `SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>? AND ${activeProfileSql}`,
    )
    .bind(
      session.sessionId,
      session.tenant.userId,
      Date.now(),
      session.tenant.userId,
    )
    .first();
  if (!found) throw new MailboxError("UNAUTHENTICATED");
}

/** Local owner management remains available when provider OAuth is disabled. */
export function createMailboxManagement(
  db: D1Database,
  provider?: "gmail" | "outlook",
) {
  async function row(context: TenantContext, id: string) {
    return db
      .prepare(
        `SELECT ${fields} FROM connections WHERE user_id=? AND id=? AND kind='mailbox' AND provider IN('gmail','outlook') AND (? IS NULL OR provider=?) AND ${activeProfileSql}`,
      )
      .bind(
        context.userId,
        id,
        provider ?? null,
        provider ?? null,
        context.userId,
      )
      .first<ConnectionRow>();
  }
  async function list(context: TenantContext) {
    const result = await db
      .prepare(
        `SELECT ${fields} FROM connections WHERE user_id=? AND kind='mailbox' AND provider IN('gmail','outlook') AND ${activeProfileSql} ORDER BY CASE state WHEN 'disconnected' THEN 1 ELSE 0 END,id LIMIT 11`,
      )
      .bind(context.userId, context.userId)
      .all<ConnectionRow>();
    return {
      connections: result.results.slice(0, 10).map(project),
      hasMore: result.results.length > 10,
    };
  }
  async function disconnect(
    session: MailboxSession,
    id: string,
    expected: { generation: number; credentialVersion: number },
  ) {
    requireRecentMailboxSession(session, Date.now());
    await liveMailboxSession(db, session);
    const existing = await row(session.tenant, id);
    if (!existing) throw new MailboxError("NOT_FOUND");
    if (
      existing.state === "disconnected" &&
      existing.generation === expected.generation + 1 &&
      existing.credential_version === expected.credentialVersion + 1
    )
      return;
    const changed = await db
      .prepare(
        `UPDATE connections SET state='disconnected',scheduling_state='paused',next_sync_at=NULL,credential_ciphertext=NULL,credential_key_version=NULL,generation=generation+1,credential_version=credential_version+1 WHERE user_id=? AND id=? AND kind='mailbox' AND provider=? AND state!='disconnected' AND generation=? AND credential_version=? AND generation<? AND credential_version<? AND EXISTS(SELECT 1 FROM session WHERE id=? AND userId=? AND expiresAt>?) AND ${activeProfileSql} RETURNING id`,
      )
      .bind(
        session.tenant.userId,
        id,
        existing.provider,
        expected.generation,
        expected.credentialVersion,
        MAX,
        MAX,
        session.sessionId,
        session.tenant.userId,
        Date.now(),
        session.tenant.userId,
      )
      .first();
    if (!changed) throw new MailboxError("CONFLICT");
  }
  return {
    list: (...args: Parameters<typeof list>) => safe(() => list(...args)),
    disconnect: (...args: Parameters<typeof disconnect>) =>
      safe(() => disconnect(...args)),
  };
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof MailboxError) throw cause;
    throw new MailboxError("UNAVAILABLE");
  }
}
