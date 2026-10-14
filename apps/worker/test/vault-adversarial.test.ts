import { env } from "cloudflare:workers";
import type { TenantContext } from "@invoxim/core";
import { beforeAll, expect, it } from "vitest";
import baseline from "../../../packages/adapters/migrations/0001_initial.sql?raw";

import {
  createCredentialCipher,
  encodeBase64url,
} from "../../../packages/adapters/src/security/cipher";
import { createOAuthStateStore } from "../../../packages/adapters/src/security/oauth-state";
import type {
  CipherBinding,
  CredentialCipher,
  CredentialTarget,
} from "../../../packages/adapters/src/security/types";
import { createCredentialVault } from "../../../packages/adapters/src/security/vault";
import { requireFixture } from "../../../packages/testkit/src/fixture-value";

const db = env.DB;

// Synthetic test authority and key material, never a request-identity factory.
const tenant = (userId: string) =>
  ({ userId, authority: "job" }) as TenantContext;
const keyOne = encodeBase64url(new Uint8Array(32).fill(1));
const keyTwo = encodeBase64url(new Uint8Array(32).fill(2));
const binding = {
  entityId: "synthetic-connection",
  purpose: "mailbox-credentials",
} as const;
const syntheticCredentials = {
  accessToken: "synthetic-access-value",
  refreshToken: "synthetic-refresh-value",
};
const cipher = createCredentialCipher({
  activeVersion: 1,
  keys: { 1: keyOne },
});
const vault = createCredentialVault(db, cipher);
const sessionTenant = (userId: string) =>
  ({ userId, authority: "session" }) as TenantContext;
const callbacks = {
  mailbox: {
    google: "https://synthetic.example/api/oauth/mailbox/google",
    microsoft: "https://synthetic.example/api/oauth/mailbox/microsoft",
  },
  storage: { google: "https://synthetic.example/api/oauth/storage/google" },
};
beforeAll(async () => {
  for (const sql of [baseline]) {
    for (const statement of sql.split(";").filter((value) => value.trim()))
      await db.prepare(statement).run();
  }
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
    for (const suffix of ["one", "two", "revoked"]) {
      await db
        .prepare(
          'INSERT INTO "session"(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,10000000,0,0)',
        )
        .bind(`${user}-${suffix}`, user, `synthetic-session-${user}-${suffix}`)
        .run();
    }
  }
});
async function connection(user: string, id: string): Promise<CredentialTarget> {
  await db
    .prepare(
      "INSERT INTO connections(id,user_id,kind,provider,provider_subject,display_address,scheduling_state) VALUES(?,?,'mailbox','gmail',?,?,'active')",
    )
    .bind(id, user, id, `${id}@example.invalid`)
    .run();
  return { kind: "connection", id, generation: 1 };
}
function decryptBarrier() {
  let entered!: () => void;
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const delayed: CredentialCipher = {
    ...cipher,
    async open(context, selected, envelope) {
      const value = await cipher.open(context, selected, envelope);
      entered();
      await released;
      return value;
    },
  };
  return { delayed, pending, resume };
}
async function failureCode(operation: () => Promise<unknown>) {
  try {
    await operation();
    return "RESOLVED";
  } catch (error) {
    // Expose only safe code to assertions, never token values or raw exceptions.
    return error instanceof Error && error.message === "SECRET_UNAVAILABLE"
      ? "SECRET_UNAVAILABLE"
      : "UNEXPECTED_ERROR";
  }
}
it("SECRETS-02 tenant, entity and purpose ciphertext swaps fail authentication", async () => {
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: keyOne },
  });
  const envelope = await cipher.seal(
    tenant("vault-a"),
    binding,
    syntheticCredentials,
  );
  const contexts = [
    { context: tenant("vault-b"), binding },
    {
      context: tenant("vault-a"),
      binding: { ...binding, entityId: "other-connection" },
    },
    {
      context: tenant("vault-a"),
      binding: { ...binding, purpose: "storage-credentials" } as CipherBinding,
    },
  ];
  for (const changed of contexts) {
    expect(
      await failureCode(() =>
        cipher.open(changed.context, changed.binding, envelope),
      ),
    ).toBe("SECRET_UNAVAILABLE");
  }
  const opened = await cipher.open(tenant("vault-a"), binding, envelope);
  expect(opened.refreshToken === syntheticCredentials.refreshToken).toBe(true);
});
it("SECRETS-02 envelope version, nonce and ciphertext tampering cannot decrypt", async () => {
  // Identical bytes under two versions isolate key-version AAD authentication.
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: keyOne, 2: keyOne },
  });
  const envelope = await cipher.seal(
    tenant("vault-a"),
    binding,
    syntheticCredentials,
  );
  const original = JSON.parse(envelope) as {
    schemaVersion: number;
    keyVersion: number;
    nonce: string;
    ciphertext: string;
  };
  const mutated = [
    { ...original, schemaVersion: 2 },
    { ...original, keyVersion: 2 },
    { ...original, nonce: encodeBase64url(new Uint8Array(12)) },
    { ...original, ciphertext: original.ciphertext.slice(0, -2) },
    { ...original, unexpected: "synthetic-private-marker" },
  ];
  for (const value of mutated) {
    expect(
      await failureCode(() =>
        cipher.open(tenant("vault-a"), binding, JSON.stringify(value)),
      ),
    ).toBe("SECRET_UNAVAILABLE");
  }
});
it("SECRETS-01 repeated sealing uses distinct nonce envelopes and retains no plaintext", async () => {
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: keyOne },
  });
  const envelopes = await Promise.all(
    Array.from({ length: 16 }, () =>
      cipher.seal(tenant("vault-a"), binding, syntheticCredentials),
    ),
  );
  const nonces = envelopes.map(
    (value) =>
      (
        JSON.parse(value) as {
          nonce: string;
        }
      ).nonce,
  );
  expect(new Set(nonces).size).toBe(16);
  for (const envelope of envelopes) {
    expect(envelope.includes(syntheticCredentials.accessToken)).toBe(false);
    expect(envelope.includes(syntheticCredentials.refreshToken)).toBe(false);
    expect(
      (
        JSON.parse(envelope) as {
          nonce: string;
        }
      ).nonce.length,
    ).toBe(16);
  }
});
it("SECRETS-03 active-key encryption and old-key decryption preserve rotation boundaries", async () => {
  const old = createCredentialCipher({ activeVersion: 1, keys: { 1: keyOne } });
  const current = createCredentialCipher({
    activeVersion: 2,
    keys: { 1: keyOne, 2: keyTwo },
  });
  const envelope = await old.seal(
    tenant("vault-a"),
    binding,
    syntheticCredentials,
  );
  const opened = await current.open(tenant("vault-a"), binding, envelope);
  expect(opened.refreshToken === syntheticCredentials.refreshToken).toBe(true);
  const rotated = await current.seal(tenant("vault-a"), binding, opened);
  expect(
    (
      JSON.parse(rotated) as {
        keyVersion: number;
      }
    ).keyVersion,
  ).toBe(2);
  expect(
    (
      JSON.parse(rotated) as {
        nonce: string;
      }
    ).nonce ===
      (
        JSON.parse(envelope) as {
          nonce: string;
        }
      ).nonce,
  ).toBe(false);
  const retired = createCredentialCipher({
    activeVersion: 2,
    keys: { 2: keyTwo },
  });
  expect(
    await failureCode(() => retired.open(tenant("vault-a"), binding, envelope)),
  ).toBe("SECRET_UNAVAILABLE");
  expect(
    (await retired.open(tenant("vault-a"), binding, rotated)).accessToken ===
      syntheticCredentials.accessToken,
  ).toBe(true);
});
it("SECRETS-01 bounded Unicode input cannot produce an unreadable accepted envelope", async () => {
  const cipher = createCredentialCipher({
    activeVersion: 1,
    keys: { 1: keyOne },
  });
  const value = { accessToken: "€".repeat(8192) };
  let envelope: string;
  try {
    envelope = await cipher.seal(tenant("vault-a"), binding, value);
  } catch (error) {
    // A safe pre-encryption byte-bound rejection is acceptable.
    expect(error instanceof Error && error.message === "INVALID_SECRET").toBe(
      true,
    );
    return;
  }
  let readable = false;
  try {
    readable =
      (await cipher.open(tenant("vault-a"), binding, envelope)).accessToken ===
      value.accessToken;
  } catch {
    readable = false;
  }
  expect(readable).toBe(true);
});
it("SECRETS-01/02 D1 ownership and safe metadata resist ciphertext substitution", async () => {
  const target = await connection("vault-a", "ownership");
  await connection("vault-b", "ownership");
  expect(
    await vault.save(tenant("vault-a"), target, 0, syntheticCredentials),
  ).toBe(true);
  const stored = await db
    .prepare(
      "SELECT credential_ciphertext FROM connections WHERE user_id='vault-a' AND id='ownership'",
    )
    .first<string>("credential_ciphertext");
  expect(typeof stored).toBe("string");
  expect(
    requireFixture(stored).includes(syntheticCredentials.refreshToken),
  ).toBe(false);
  const metadata = await vault.metadata(tenant("vault-a"), target);
  expect(metadata).toEqual({
    configured: true,
    version: 1,
    keyVersion: 1,
    generation: 1,
  });
  expect(await vault.read(tenant("vault-b"), target)).toBeNull();
  await db
    .prepare(
      "UPDATE connections SET credential_ciphertext=?,credential_key_version=1,credential_version=1 WHERE user_id='vault-b' AND id='ownership'",
    )
    .bind(stored)
    .run();
  expect(await failureCode(() => vault.read(tenant("vault-b"), target))).toBe(
    "SECRET_UNAVAILABLE",
  );
  expect((await vault.read(tenant("vault-a"), target))?.version).toBe(1);
  const missing = {
    kind: "connection",
    id: "absent-owner-target",
    generation: 1,
  } as const;
  expect(
    await vault.save(tenant("vault-b"), missing, 0, syntheticCredentials),
  ).toBe(false);
  expect(await vault.clear(tenant("vault-b"), missing, 0)).toBe(false);
});
it("SECRETS-04 concurrent refresh CAS preserves the winning token set and omitted refresh", async () => {
  const target = await connection("vault-a", "refresh-race");
  await vault.save(tenant("vault-a"), target, 0, syntheticCredentials);
  const responses = [
    { accessToken: "synthetic-access-first" },
    {
      accessToken: "synthetic-access-second",
      refreshToken: "synthetic-refresh-rotated",
    },
  ];
  const results = await Promise.all(
    responses.map((response) =>
      vault.refresh(tenant("vault-a"), target, 1, response),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results.findIndex(Boolean);
  const saved = await vault.read(tenant("vault-a"), target);
  expect(saved?.version).toBe(2);
  if (!saved || "key" in saved.secret)
    throw new Error("Synthetic credential result unavailable");
  expect(
    saved.secret.accessToken === requireFixture(responses[winner]).accessToken,
  ).toBe(true);
  expect(
    saved.secret.refreshToken ===
      (requireFixture(responses[winner]).refreshToken ??
        syntheticCredentials.refreshToken),
  ).toBe(true);
  expect(
    await vault.refresh(tenant("vault-a"), target, 1, {
      accessToken: "synthetic-stale-refresh",
    }),
  ).toBe(false);
  expect((await vault.read(tenant("vault-a"), target))?.version).toBe(2);
});
it("SECRETS-03 persisted rotation uses the active key and rejects stale revisions", async () => {
  const target = await connection("vault-a", "rotation");
  await vault.save(tenant("vault-a"), target, 0, syntheticCredentials);
  const rotating = createCredentialVault(
    db,
    createCredentialCipher({
      activeVersion: 2,
      keys: { 1: keyOne, 2: keyTwo },
    }),
  );
  expect(await rotating.rotate(tenant("vault-a"), target, 1)).toBe(true);
  expect(await rotating.metadata(tenant("vault-a"), target)).toEqual({
    configured: true,
    version: 2,
    keyVersion: 2,
    generation: 1,
  });
  expect(await rotating.rotate(tenant("vault-a"), target, 1)).toBe(false);
  expect(
    await vault.refresh(tenant("vault-a"), target, 1, {
      accessToken: "synthetic-obsolete-key-response",
    }),
  ).toBe(false);
  expect(
    await vault.save(tenant("vault-a"), target, 2, syntheticCredentials),
  ).toBe(false);
  expect(await failureCode(() => vault.read(tenant("vault-a"), target))).toBe(
    "SECRET_UNAVAILABLE",
  );
  const saved = await rotating.read(tenant("vault-a"), target);
  expect(
    saved !== null &&
      "refreshToken" in saved.secret &&
      saved.secret.refreshToken === syntheticCredentials.refreshToken,
  ).toBe(true);
});
it("SECRETS-01 deletion during real decrypt blocks returning or resurrecting credentials", async () => {
  const target = await connection("vault-a", "delete-race");
  await vault.save(tenant("vault-a"), target, 0, syntheticCredentials);
  const barrier = decryptBarrier();
  const delayedVault = createCredentialVault(db, barrier.delayed);
  const pendingRead = delayedVault.read(tenant("vault-a"), target);
  await barrier.pending;
  expect(await vault.clear(tenant("vault-a"), target, 1)).toBe(true);
  barrier.resume();
  expect(await pendingRead).toBeNull();
  expect(
    await vault.save(tenant("vault-a"), target, 1, syntheticCredentials),
  ).toBe(false);
  expect(
    await vault.refresh(tenant("vault-a"), target, 1, {
      accessToken: "synthetic-late-response",
    }),
  ).toBe(false);
  expect(await vault.read(tenant("vault-a"), target)).toBeNull();
  const byok = { kind: "byok", id: "primary", generation: 1 } as const;
  expect(
    await vault.save(tenant("vault-a"), byok, 0, {
      key: "synthetic-byok-value",
    }),
  ).toBe(true);
  expect(await vault.clear(tenant("vault-a"), byok, 1)).toBe(true);
  expect(
    await vault.save(tenant("vault-a"), { ...byok, generation: 2 }, 2, {
      key: "synthetic-late-key",
    }),
  ).toBe(false);
  expect(
    await vault.metadata(tenant("vault-a"), { ...byok, generation: 2 }),
  ).toEqual({ configured: false, version: 2, keyVersion: null, generation: 2 });
});
it("AUTH-03 OAuth state is bound to session, tenant, purpose, provider and fixed callback", async () => {
  const store = createOAuthStateStore(db, cipher, {
    callbacks,
    clock: () => 1000,
  });
  const selected = {
    sessionId: "vault-a-one",
    purpose: "mailbox",
    provider: "google",
  } as const;
  const verifier = "v".repeat(43);
  const created = await store.create(sessionTenant("vault-a"), {
    ...selected,
    pkceVerifier: verifier,
  });
  const row = await db
    .prepare(
      "SELECT state_hash,pkce_ciphertext FROM oauth_states WHERE user_id='vault-a'",
    )
    .first<{
      state_hash: string;
      pkce_ciphertext: string;
    }>();
  expect(row?.state_hash.length).toBe(64);
  expect(row?.state_hash === created.state).toBe(false);
  expect(row?.pkce_ciphertext.includes(verifier)).toBe(false);
  const input = {
    ...selected,
    state: created.state,
    callback: created.callback,
  };
  for (const changed of [
    {
      context: sessionTenant("vault-b"),
      input: { ...input, sessionId: "vault-b-one" },
    },
    {
      context: sessionTenant("vault-a"),
      input: { ...input, sessionId: "vault-a-two" },
    },
    {
      context: sessionTenant("vault-a"),
      input: {
        ...input,
        purpose: "storage",
        callback: callbacks.storage.google,
      } as const,
    },
    {
      context: sessionTenant("vault-a"),
      input: {
        ...input,
        provider: "microsoft",
        callback: callbacks.mailbox.microsoft,
      } as const,
    },
    {
      context: sessionTenant("vault-a"),
      input: { ...input, callback: "https://unapproved.invalid/" },
    },
  ])
    expect(await store.consume(changed.context, changed.input)).toBeNull();
  const consumed = await Promise.all([
    store.consume(sessionTenant("vault-a"), input),
    store.consume(sessionTenant("vault-a"), input),
  ]);
  expect(consumed.filter((value) => value !== null)).toHaveLength(1);
  expect(
    consumed.some(
      (value) =>
        value?.pkceVerifier === verifier && value.nonce === created.nonce,
    ),
  ).toBe(true);
  expect(await store.consume(sessionTenant("vault-a"), input)).toBeNull();
  expect(
    await db
      .prepare(
        "SELECT pkce_ciphertext,pkce_key_version,nonce FROM oauth_states WHERE user_id='vault-a'",
      )
      .first(),
  ).toEqual({ pkce_ciphertext: null, pkce_key_version: null, nonce: null });
});
it("AUTH-03 expired state rejects at the exact boundary and purges only its owner", async () => {
  let now = 1000;
  const store = createOAuthStateStore(db, cipher, {
    callbacks,
    clock: () => now,
  });
  const selected = {
    sessionId: "vault-a-two",
    purpose: "mailbox",
    provider: "google",
  } as const;
  const created = await store.create(sessionTenant("vault-a"), {
    ...selected,
    pkceVerifier: "x".repeat(43),
  });
  await store.create(sessionTenant("vault-b"), {
    ...selected,
    sessionId: "vault-b-two",
    pkceVerifier: "y".repeat(43),
  });
  expect(created.expiresAt - now).toBe(600000);
  now = created.expiresAt;
  expect(
    await store.consume(sessionTenant("vault-a"), {
      ...selected,
      state: created.state,
      callback: created.callback,
    }),
  ).toBeNull();
  expect(await store.purgeExpired(sessionTenant("vault-a"), 1)).toBe(1);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM oauth_states WHERE user_id='vault-b'",
      )
      .first<number>("count"),
  ).toBe(1);
});
it("AUTH-03 session revocation during actual PKCE decrypt prevents state consumption", async () => {
  const selected = {
    sessionId: "vault-a-revoked",
    purpose: "mailbox",
    provider: "google",
  } as const;
  const store = createOAuthStateStore(db, cipher, {
    callbacks,
    clock: () => 1000,
  });
  const created = await store.create(sessionTenant("vault-a"), {
    ...selected,
    pkceVerifier: "z".repeat(43),
  });
  const barrier = decryptBarrier();
  const delayed = createOAuthStateStore(db, barrier.delayed, {
    callbacks,
    clock: () => 1000,
  });
  const pending = delayed.consume(sessionTenant("vault-a"), {
    ...selected,
    state: created.state,
    callback: created.callback,
  });
  await barrier.pending;
  await db
    .prepare('UPDATE "session" SET expiresAt=0 WHERE id=?')
    .bind(selected.sessionId)
    .run();
  barrier.resume();
  expect(await pending).toBeNull();
});
