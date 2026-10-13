ALTER TABLE connections ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0 CHECK(credential_version>=0 AND ((credential_ciphertext IS NULL AND credential_key_version IS NULL) OR (credential_ciphertext IS NOT NULL AND credential_key_version IS NOT NULL AND credential_key_version>0)));
CREATE TABLE ai_settings (
 user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
 id TEXT NOT NULL DEFAULT 'primary' CHECK(id='primary'),
 encrypted_key TEXT, key_version INTEGER, credential_version INTEGER NOT NULL DEFAULT 0 CHECK(credential_version>=0),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
 UNIQUE(user_id,id),
 CHECK((encrypted_key IS NULL AND key_version IS NULL) OR (encrypted_key IS NOT NULL AND key_version IS NOT NULL AND key_version>0))
);
CREATE UNIQUE INDEX sessions_tenant_identity ON "session"(userId,id);
CREATE TABLE oauth_states (
 state_hash TEXT PRIMARY KEY CHECK(length(state_hash)=64),
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('mailbox','storage')),
 provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')), callback TEXT NOT NULL,
 pkce_ciphertext TEXT, pkce_key_version INTEGER, nonce TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+600000), consumed_at INTEGER,
 FOREIGN KEY(user_id,session_id) REFERENCES "session"(userId,id) ON DELETE CASCADE,
 CHECK((consumed_at IS NULL AND pkce_ciphertext IS NOT NULL AND pkce_key_version IS NOT NULL AND pkce_key_version>0 AND nonce IS NOT NULL) OR
 (consumed_at IS NOT NULL AND pkce_ciphertext IS NULL AND pkce_key_version IS NULL AND nonce IS NULL))
);
CREATE INDEX oauth_states_tenant_expiry ON oauth_states(user_id,expires_at,state_hash);
