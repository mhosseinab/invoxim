// Explicit populated historical credential-upgrade fixture.

import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import { createCredentialCipher } from "../../../packages/adapters/src/security/cipher";
import { createOAuthStateStore } from "../../../packages/adapters/src/security/oauth-state";
import { createCredentialVault } from "../../../packages/adapters/src/security/vault";
import auth from "./migrations/historical/0001_auth.sql?raw";
import records from "./migrations/historical/0002_records.sql?raw";
import indexes from "./migrations/historical/0003_indexes_and_schedule.sql?raw";
import security from "./migrations/historical/0004_credentials_and_oauth.sql?raw";

const db = env.DB;

const tenant = (userId: string) =>
  ({ userId, authority: "session" }) as TenantContext;
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
it("SECRETS-02: ciphertext copied from tenant A to tenant B cannot decrypt", async () => {
  const cipher = createCredentialCipher({ activeVersion: 1, keys: { 1: key } });
  const binding = {
    entityId: "connection-a",
    purpose: "mailbox-credentials",
  } as const;
  const encrypted = await cipher.seal(tenant("vault-a"), binding, {
    refreshToken: "synthetic-refresh-do-not-use",
  });
  await expect(
    cipher.open(tenant("vault-b"), binding, encrypted),
  ).rejects.toThrow();
});

const currentKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const callbacks = {
  mailbox: { google: "https://app.example.invalid/api/oauth/mailbox/google" },
  storage: { google: "https://app.example.invalid/api/oauth/storage/google" },
} as const;
beforeAll(async () => {
  for (const sql of [auth, records, indexes])
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
  for (const user of ["vault-a", "vault-b"]) {
    await db
      .prepare(
        'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
      )
      .bind(user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        "INSERT INTO profiles(user_id,created_at,updated_at) VALUES(?,0,0)",
      )
      .bind(user)
      .run();
    await db
      .prepare(
        "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address) VALUES(?,?,'mailbox','gmail',?,?)",
      )
      .bind(`connection-${user}`, user, user, `${user}@example.invalid`)
      .run();
    await db
      .prepare(
        'INSERT INTO "session"(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,1000000,0,0)',
      )
      .bind(`session-${user}`, user, `synthetic-session-${user}`)
      .run();
  }
  const legacyCipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: key },
  });
  const legacyEnvelope = await legacyCipher.seal(
    tenant("vault-b"),
    { entityId: "connection-vault-b", purpose: "mailbox-credentials" },
    { refreshToken: "synthetic-legacy-refresh" },
  );
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=?,credential_key_version=1 WHERE user_id='vault-b' AND id='connection-vault-b'",
    )
    .bind(legacyEnvelope)
    .run();
  for (const statement of security.split(";").filter((s) => s.trim()))
    await db.prepare(statement).run();
});
it("SECRETS-01: populated credential migration preserves connection and write-only metadata contains no secrets", async () => {
  const cipher = createCredentialCipher({ activeVersion: 1, keys: { 1: key } });
  const vault = createCredentialVault(db, cipher);
  const target = {
    kind: "connection",
    id: "connection-vault-a",
    generation: 1,
  } as const;
  expect(
    await vault.save(tenant("vault-a"), target, 0, {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
    }),
  ).toBe(true);
  const stored = await db
    .prepare(
      "SELECT credential_ciphertext,credential_key_version,credential_version FROM connections WHERE user_id='vault-a' AND id='connection-vault-a'",
    )
    .first();
  expect(JSON.stringify(stored).includes("synthetic-access")).toBe(false);
  expect(JSON.stringify(stored).includes("synthetic-refresh")).toBe(false);
  expect(await vault.metadata(tenant("vault-a"), target)).toEqual({
    configured: true,
    keyVersion: 1,
    version: 1,
    generation: 1,
  });
  expect((await vault.read(tenant("vault-a"), target))?.secret).toEqual({
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
  });
  expect(await vault.read(tenant("vault-b"), target)).toBeNull();
  const legacyTarget = {
    kind: "connection",
    id: "connection-vault-b",
    generation: 1,
  } as const;
  expect((await vault.read(tenant("vault-b"), legacyTarget))?.secret).toEqual({
    refreshToken: "synthetic-legacy-refresh",
  });
  expect(await vault.metadata(tenant("vault-b"), legacyTarget)).toEqual({
    configured: true,
    keyVersion: 1,
    version: 0,
    generation: 1,
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
it("SECRETS-03/04: rotation CAS preserves refreshed values and omitted refresh token survives", async () => {
  const oldCipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: key },
  });
  const oldVault = createCredentialVault(db, oldCipher);
  const target = {
    kind: "connection",
    id: "connection-vault-a",
    generation: 1,
  } as const;
  expect(
    await oldVault.refresh(tenant("vault-a"), target, 1, {
      accessToken: "synthetic-refreshed",
      expiresAt: 5000,
    }),
  ).toBe(true);
  expect((await oldVault.read(tenant("vault-a"), target))?.secret).toEqual({
    accessToken: "synthetic-refreshed",
    refreshToken: "synthetic-refresh",
    expiresAt: 5000,
  });
  const newCipher = createCredentialCipher({
    activeVersion: 2,
    keys: { 1: key, 2: currentKey },
  });
  const newVault = createCredentialVault(db, newCipher);
  expect(await newVault.rotate(tenant("vault-a"), target, 2)).toBe(true);
  expect(
    await oldVault.refresh(tenant("vault-a"), target, 2, {
      refreshToken: "synthetic-late-refresh",
    }),
  ).toBe(false);
  expect((await newVault.read(tenant("vault-a"), target))?.keyVersion).toBe(2);
  const staleConfiguredVault = createCredentialVault(
    db,
    createCredentialCipher({
      activeVersion: 1,
      keys: { 1: key, 2: currentKey },
    }),
  );
  expect(await staleConfiguredVault.rotate(tenant("vault-a"), target, 3)).toBe(
    false,
  );
});
it("SECRETS-01: BYOK clear fences stale writers and physically clears retained ciphertext", async () => {
  const vault = createCredentialVault(
    db,
    createCredentialCipher({ activeVersion: 2, keys: { 2: currentKey } }),
  );
  const target = { kind: "byok", id: "primary", generation: 1 } as const;
  expect(
    await vault.save(tenant("vault-a"), target, 0, {
      key: "synthetic-byok-secret",
    }),
  ).toBe(true);
  expect(await vault.clear(tenant("vault-a"), target, 1)).toBe(true);
  expect(await vault.read(tenant("vault-a"), target)).toBeNull();
  expect(
    await vault.save(tenant("vault-a"), target, 1, {
      key: "synthetic-resurrection",
    }),
  ).toBe(false);
  expect(await vault.metadata(tenant("vault-a"), target)).toEqual({
    configured: false,
    keyVersion: null,
    version: 2,
    generation: 2,
  });
  expect(
    await db
      .prepare("SELECT encrypted_key FROM ai_settings WHERE user_id='vault-a'")
      .first("encrypted_key"),
  ).toBeNull();
});
it("SECRETS-01/02: OAuth state is hashed, PKCE encrypted, wrong binding stays usable, winner clears secrets", async () => {
  const cipher = createCredentialCipher({
    activeVersion: 2,
    keys: { 2: currentKey },
  });
  const states = createOAuthStateStore(db, cipher, {
    callbacks,
    clock: () => 1000,
  });
  const binding = {
    sessionId: "session-vault-a",
    purpose: "mailbox",
    provider: "google",
  } as const;
  const issued = await states.create(tenant("vault-a"), {
    ...binding,
    pkceVerifier: "x".repeat(43),
  });
  expect(issued.expiresAt).toBe(601000);
  const row = await db
    .prepare(
      "SELECT state_hash,pkce_ciphertext FROM oauth_states WHERE user_id='vault-a'",
    )
    .first();
  expect(JSON.stringify(row).includes(issued.state)).toBe(false);
  expect(JSON.stringify(row).includes("x".repeat(43))).toBe(false);
  expect(
    await states.consume(tenant("vault-a"), {
      ...binding,
      state: issued.state,
      callback: callbacks.storage.google,
    }),
  ).toBeNull();
  const result = await states.consume(tenant("vault-a"), {
    ...binding,
    state: issued.state,
    callback: issued.callback,
  });
  expect(result).toEqual({ pkceVerifier: "x".repeat(43), nonce: issued.nonce });
  expect(
    await states.consume(tenant("vault-a"), {
      ...binding,
      state: issued.state,
      callback: issued.callback,
    }),
  ).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT pkce_ciphertext,nonce FROM oauth_states WHERE user_id='vault-a'",
      )
      .first(),
  ).toEqual({ pkce_ciphertext: null, nonce: null });
});
it("SECRETS-01: credential and OAuth schema reject missing authenticated key versions", async () => {
  await expect(
    db
      .prepare(
        "UPDATE connections SET credential_key_version=NULL WHERE user_id='vault-b' AND id='connection-vault-b'",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE connections SET credential_ciphertext=NULL WHERE user_id='vault-b' AND id='connection-vault-b'",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO ai_settings(user_id,id,encrypted_key,key_version) VALUES('vault-b','primary','{}',NULL)",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO oauth_states(state_hash,user_id,session_id,purpose,provider,callback,pkce_ciphertext,pkce_key_version,nonce,created_at,expires_at) VALUES(?,'vault-b','session-vault-b','mailbox','google',?,'{}',NULL,'synthetic-nonce',0,600000)",
      )
      .bind("f".repeat(64), callbacks.mailbox.google)
      .run(),
  ).rejects.toThrow();
  const plan = (
    await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT state_hash FROM oauth_states WHERE user_id=? AND expires_at<=? ORDER BY expires_at,state_hash LIMIT 100",
      )
      .bind("vault-a", 601000)
      .all<{ detail: string }>()
  ).results;
  expect(plan.map((row) => row.detail).join(" ")).toContain(
    "oauth_states_tenant_expiry",
  );
});
it("SECRETS-01: unexpected database failures expose no credential text in message, stack or serialization", async () => {
  const marker = "synthetic-private-key-do-not-log";
  const failureDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          throw new Error(marker);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const cipher = createCredentialCipher({ activeVersion: 1, keys: { 1: key } });
  const vault = createCredentialVault(failureDb, cipher);
  const states = createOAuthStateStore(failureDb, cipher, {
    callbacks,
    clock: () => 1000,
  });
  for (const operation of [
    () =>
      vault.metadata(tenant("vault-a"), {
        kind: "connection",
        id: "connection-vault-a",
        generation: 1,
      }),
    () => states.purgeExpired(tenant("vault-a")),
  ]) {
    let failure: unknown;
    try {
      await operation();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "SECRET_UNAVAILABLE",
    });
    expect(failure instanceof Error && failure.stack?.includes(marker)).toBe(
      false,
    );
    expect(JSON.stringify(failure).includes(marker)).toBe(false);
  }
});
it("SECRETS-04: reconnect save without refresh token preserves existing valid refresh credential", async () => {
  const vault = createCredentialVault(
    db,
    createCredentialCipher({ activeVersion: 2, keys: { 2: currentKey } }),
  );
  const target = {
    kind: "connection",
    id: "connection-vault-b",
    generation: 1,
  } as const;
  expect(
    await vault.save(tenant("vault-b"), target, 0, {
      accessToken: "synthetic-connect-access",
      refreshToken: "synthetic-connect-refresh",
    }),
  ).toBe(true);
  expect(
    await vault.save(tenant("vault-b"), target, 1, {
      accessToken: "synthetic-reconnect-access",
    }),
  ).toBe(true);
  expect((await vault.read(tenant("vault-b"), target))?.secret).toEqual({
    accessToken: "synthetic-reconnect-access",
    refreshToken: "synthetic-connect-refresh",
  });
});

it("SECRETS-02 binds encrypted archive upload sessions to tenant and object identity", async () => {
  const cipher = createCredentialCipher({ activeVersion: 1, keys: { 1: key } });
  const binding = {
    entityId: "archive-object-a",
    purpose: "archive-upload-session",
  } as const;
  const value = {
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic",
    fileId: "synthetic-file",
    sha256: "a".repeat(64),
  };
  const envelope = await cipher.seal(tenant("vault-a"), binding, value);
  expect(envelope).not.toContain(value.url);
  expect(await cipher.open(tenant("vault-a"), binding, envelope)).toEqual(
    value,
  );
  await expect(
    cipher.open(tenant("vault-b"), binding, envelope),
  ).rejects.toThrow();
  await expect(
    cipher.open(
      tenant("vault-a"),
      { ...binding, entityId: "archive-object-b" },
      envelope,
    ),
  ).rejects.toThrow();
  await expect(
    cipher.open(
      tenant("vault-a"),
      { ...binding, purpose: "storage-credentials" },
      envelope,
    ),
  ).rejects.toThrow();
});
