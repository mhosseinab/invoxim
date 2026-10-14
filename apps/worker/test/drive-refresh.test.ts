import { env } from "cloudflare:workers";
import { createLoginAuth, createProfileService } from "@invoxim/adapters";
import type {
  ArchiveAuthorizationPort,
  ArchiveCredentials,
  ArchiveIdentity,
  TenantContext,
} from "@invoxim/core";
import { ArchiveAuthorizationError } from "@invoxim/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";
import { DRIVE_AUTHORIZATION_SCOPES } from "../../../packages/adapters/src/drive/configuration";
import { createDriveCredentialRefresher } from "../../../packages/adapters/src/drive/refresh";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import type {
  CipherBinding,
  CredentialCipher,
  SecretPayloads,
  SecretPurpose,
} from "../../../packages/adapters/src/security/types";
import { createCredentialVault } from "../../../packages/adapters/src/security/vault";
import { createInvocationDatabase } from "../src/invocation-database";

const db = env.DB;

const login = {
  origin: "https://synthetic.example",
  secret: "synthetic-refresh-login-secret-123456789",
  googleClientId: "synthetic-login.apps.googleusercontent.com",
  googleClientSecret: "synthetic-login-secret",
  allowedEmails: ["refresh-login@example.test"],
};
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: {
    1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  },
});
let tenant: TenantContext;
const id = "synthetic-drive-refresh-connection";
const subject = "synthetic-independent-drive-subject";
const old = {
  accessToken: "synthetic-old-drive-access",
  refreshToken: "synthetic-old-drive-refresh",
  expiresAt: Date.now() - 1000,
};
async function successfulRefresh(
  current: ArchiveCredentials,
  identity: ArchiveIdentity,
): Promise<ArchiveCredentials> {
  expect(current).toEqual(old);
  expect(identity).toEqual({ subject, address: "drive-c@example.test" });
  return {
    accessToken: "synthetic-new-drive-access",
    expiresAt: Date.now() + 3600000,
  };
}
const provider: ArchiveAuthorizationPort = {
  authorize: async () => "https://accounts.google.com/o/oauth2/v2/auth",
  exchange: async () => {
    throw new Error("Synthetic refresh must not exchange authorization");
  },
  refresh: vi.fn(successfulRefresh),
};
beforeAll(async () => {
  for (const sql of [baseline])
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)",
    )
    .bind(
      "synthetic-refresh-user",
      "Synthetic Refresh Login",
      "refresh-login@example.test",
      Date.now(),
      Date.now(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,?,?)",
    )
    .bind("synthetic-refresh-user", Date.now(), Date.now())
    .run();
  const loginAuth = createLoginAuth(db, login);
  const internal = await loginAuth.$context;
  const created = await internal.internalAdapter.createSession(
    "synthetic-refresh-user",
    false,
  );
  if (!created) throw new Error("Synthetic refresh session unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(login.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(created.token),
  );
  const cookie =
    "__Secure-better-auth.session_token=" +
    encodeURIComponent(
      created.token +
        "." +
        btoa(String.fromCharCode(...new Uint8Array(signature))),
    );
  const verified = await createProfileService(db, loginAuth, login).current(
    new Headers({ Cookie: cookie }),
  );
  if (!verified)
    throw new Error("Synthetic refresh session verification failed");
  tenant = verified.tenant;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(provider.refresh).mockReset().mockImplementation(successfulRefresh);
  await db
    .prepare("UPDATE profiles SET status='active' WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM lifecycle_deletions WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM archive_settings WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM storage_refresh_leases WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  await db
    .prepare("DELETE FROM connections WHERE user_id=?")
    .bind(tenant.userId)
    .run();
  const sealed = await cipher.seal(
    tenant,
    { entityId: id, purpose: "storage-credentials" },
    old,
  );
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,state,generation,scopes,credential_ciphertext,credential_key_version,credential_version,scheduling_state) VALUES(?,?,'storage','google-drive',?,?,'connected',1,?,?,1,1,'paused')",
    )
    .bind(
      id,
      tenant.userId,
      subject,
      "drive-c@example.test",
      JSON.stringify(DRIVE_AUTHORIZATION_SCOPES),
      sealed,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO archive_settings(user_id,enabled,version,connection_id,connection_generation,disclosure_version,accepted_at) VALUES(?,1,1,?,1,1,?)",
    )
    .bind(tenant.userId, id, Date.now())
    .run();
});
describe("T18 DRIVE-04 encrypted storage credential refresh", () => {
  it("refreshes the same Drive account through encrypted storage credentials while preserving explicit archive selection", async () => {
    const result = await createDriveCredentialRefresher(
      db,
      cipher,
      provider,
    ).refresh(tenant, id, { generation: 1, credentialVersion: 1 });
    expect(result).toMatchObject({
      id,
      provider: "google-drive",
      kind: "storage",
      generation: 1,
      credentialVersion: 2,
      configured: true,
      archivingEnabled: true,
    });
    expect(result).not.toHaveProperty("accessToken");
    const snapshot = await createCredentialVault(db, cipher).read(
      tenant,
      { kind: "connection", id, generation: 1 },
      2,
    );
    expect(snapshot?.secret).toMatchObject({
      accessToken: "synthetic-new-drive-access",
      refreshToken: old.refreshToken,
    });
    const record = await db
      .prepare(
        "SELECT credential_ciphertext FROM connections WHERE user_id=? AND id=?",
      )
      .bind(tenant.userId, id)
      .first<{ credential_ciphertext: string }>();
    expect(record?.credential_ciphertext).not.toContain(
      "synthetic-new-drive-access",
    );
    const settings = await db
      .prepare(
        "SELECT enabled,version,connection_id FROM archive_settings WHERE user_id=?",
      )
      .bind(tenant.userId)
      .first();
    expect(settings).toEqual({ enabled: 1, version: 1, connection_id: id });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });
  it("takes over an expired storage lease with an increasing fence and releases only its own lease", async () => {
    await db
      .prepare(
        "INSERT INTO storage_refresh_leases(user_id,connection_id,lease_id,lease_expires_at,connection_generation,credential_version,fence) VALUES(?,?,?,?,1,1,7)",
      )
      .bind(tenant.userId, id, "synthetic-expired-lease", Date.now() - 1)
      .run();
    await createDriveCredentialRefresher(db, cipher, provider).refresh(
      tenant,
      id,
      { generation: 1, credentialVersion: 1 },
    );
    expect(
      await db
        .prepare(
          "SELECT fence,lease_id,lease_expires_at FROM storage_refresh_leases WHERE user_id=? AND connection_id=?",
        )
        .bind(tenant.userId, id)
        .first(),
    ).toEqual({ fence: 8, lease_id: null, lease_expires_at: 0 });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });
});

async function storedCredentials() {
  return db
    .prepare(
      "SELECT state,generation,credential_version,credential_ciphertext FROM connections WHERE user_id=? AND id=?",
    )
    .bind(tenant.userId, id)
    .first<{
      state: string;
      generation: number;
      credential_version: number;
      credential_ciphertext: string | null;
    }>();
}
async function alterSource(field: "subject" | "scopes") {
  if (field === "subject")
    await db
      .prepare(
        "UPDATE connections SET provider_subject=? WHERE user_id=? AND id=?",
      )
      .bind("synthetic-other-drive-subject", tenant.userId, id)
      .run();
  else
    await db
      .prepare("UPDATE connections SET scopes=? WHERE user_id=? AND id=?")
      .bind(
        JSON.stringify([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/drive",
        ]),
        tenant.userId,
        id,
      )
      .run();
}
describe("T18 refresh snapshot identity and grant", () => {
  it.each(["subject", "scopes"] as const)(
    "blocks a %s mutation before provider checkpoint without credential changes",
    async (field) => {
      const before = await storedCredentials();
      let altered = false;
      const racingCipher: CredentialCipher = {
        ...cipher,
        async open<P extends SecretPurpose>(
          context: TenantContext,
          binding: CipherBinding<P>,
          envelope: string,
        ): Promise<SecretPayloads[P]> {
          const secret = await cipher.open(context, binding, envelope);
          if (!altered && binding.purpose === "storage-credentials") {
            altered = true;
            await alterSource(field);
          }
          return secret;
        },
      };
      await expect(
        createDriveCredentialRefresher(db, racingCipher, provider).refresh(
          tenant,
          id,
          { generation: 1, credentialVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await storedCredentials()).toEqual(before);
      expect(provider.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["subject", "scopes"] as const)(
    "blocks a %s mutation during provider refresh without publishing its credentials",
    async (field) => {
      const before = await storedCredentials();
      vi.mocked(provider.refresh).mockImplementation(async () => {
        await alterSource(field);
        return {
          accessToken: "synthetic-rejected-stale-access",
          expiresAt: Date.now() + 3600000,
        };
      });
      await expect(
        createDriveCredentialRefresher(db, cipher, provider).refresh(
          tenant,
          id,
          { generation: 1, credentialVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await storedCredentials()).toEqual(before);
      expect(provider.refresh).toHaveBeenCalledTimes(1);
    },
  );
});

describe("T18 refresh leases and failure fences", () => {
  it("measures the actual successful D1 invocation within the forty-statement budget", async () => {
    const meter = createInvocationDatabase(env.DB, 40);
    await createDriveCredentialRefresher(meter.db, cipher, provider).refresh(
      tenant,
      id,
      { generation: 1, credentialVersion: 1 },
    );
    expect(meter.executedStatements()).toBeLessThanOrEqual(8);
    expect(meter.remainingStatements()).toBe(32);
  });
  it.each([
    { generation: 2, credentialVersion: 1 },
    { generation: 1, credentialVersion: 2 },
  ])(
    "rejects stale counters %j before contacting the provider",
    async (expected) => {
      const before = await storedCredentials();
      await expect(
        createDriveCredentialRefresher(db, cipher, provider).refresh(
          tenant,
          id,
          expected,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await storedCredentials()).toEqual(before);
      expect(provider.refresh).not.toHaveBeenCalled();
    },
  );
  it("rejects a live competing lease without clearing it", async () => {
    const expiry = Date.now() + 60000;
    await db
      .prepare(
        "INSERT INTO storage_refresh_leases(user_id,connection_id,lease_id,lease_expires_at,connection_generation,credential_version,fence) VALUES(?,?,?,?,1,1,7)",
      )
      .bind(tenant.userId, id, "synthetic-other-lease", expiry)
      .run();
    await expect(
      createDriveCredentialRefresher(db, cipher, provider).refresh(tenant, id, {
        generation: 1,
        credentialVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db
        .prepare(
          "SELECT lease_id,fence,lease_expires_at FROM storage_refresh_leases WHERE user_id=? AND connection_id=?",
        )
        .bind(tenant.userId, id)
        .first(),
    ).toEqual({
      lease_id: "synthetic-other-lease",
      fence: 7,
      lease_expires_at: expiry,
    });
    expect(provider.refresh).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "profile", "credential", "expiry"] as const)(
    "does not publish credentials after a %s race",
    async (race) => {
      let afterRace: Awaited<ReturnType<typeof storedCredentials>> = null;
      vi.mocked(provider.refresh).mockImplementation(async () => {
        if (race === "disconnect")
          await db
            .prepare(
              "UPDATE connections SET state='disconnected',generation=generation+1,credential_version=credential_version+1,credential_ciphertext=NULL,credential_key_version=NULL WHERE user_id=? AND id=?",
            )
            .bind(tenant.userId, id)
            .run();
        if (race === "profile")
          await db
            .prepare("UPDATE profiles SET status='deleting' WHERE user_id=?")
            .bind(tenant.userId)
            .run();
        if (race === "credential")
          await db
            .prepare(
              "UPDATE connections SET credential_version=credential_version+1 WHERE user_id=? AND id=?",
            )
            .bind(tenant.userId, id)
            .run();
        if (race === "expiry")
          await db
            .prepare(
              "UPDATE storage_refresh_leases SET lease_expires_at=? WHERE user_id=? AND connection_id=?",
            )
            .bind(Date.now() - 1, tenant.userId, id)
            .run();
        afterRace = await storedCredentials();
        return {
          accessToken: "synthetic-rejected-race-access",
          expiresAt: Date.now() + 3600000,
        };
      });
      await expect(
        createDriveCredentialRefresher(db, cipher, provider).refresh(
          tenant,
          id,
          { generation: 1, credentialVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await storedCredentials()).toEqual(afterRace);
      expect(provider.refresh).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "RECONNECT_REQUIRED",
    "ACCOUNT_MISMATCH",
    "MISSING_PERMISSION",
  ] as const)(
    "marks a current %s refusal for reconnect without altering ciphertext or archive consent",
    async (code) => {
      const before = await storedCredentials();
      vi.mocked(provider.refresh).mockRejectedValue(
        new ArchiveAuthorizationError(code),
      );
      await expect(
        createDriveCredentialRefresher(db, cipher, provider).refresh(
          tenant,
          id,
          { generation: 1, credentialVersion: 1 },
        ),
      ).rejects.toMatchObject({ code });
      expect(await storedCredentials()).toEqual({
        ...before,
        state: "needs_reconnect",
      });
      expect(
        await db
          .prepare(
            "SELECT enabled,version FROM archive_settings WHERE user_id=?",
          )
          .bind(tenant.userId)
          .first(),
      ).toEqual({ enabled: 1, version: 1 });
    },
  );
  it("preserves credentials on transient provider failures and redacts unexpected errors", async () => {
    const before = await storedCredentials();
    vi.mocked(provider.refresh).mockRejectedValue(
      new Error("synthetic-private-provider-message"),
    );
    await expect(
      createDriveCredentialRefresher(db, cipher, provider).refresh(tenant, id, {
        generation: 1,
        credentialVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
    expect(await storedCredentials()).toEqual(before);
  });
  it.each(["subject", "scopes"] as const)(
    "does not apply a reconnect failure to a changed %s snapshot",
    async (field) => {
      const before = await storedCredentials();
      vi.mocked(provider.refresh).mockImplementation(async () => {
        await alterSource(field);
        throw new ArchiveAuthorizationError("RECONNECT_REQUIRED");
      });
      await expect(
        createDriveCredentialRefresher(db, cipher, provider).refresh(
          tenant,
          id,
          { generation: 1, credentialVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
      expect(await storedCredentials()).toEqual(before);
    },
  );
});
