CREATE UNIQUE INDEX oauth_states_owner_hash ON oauth_states(user_id,state_hash);
CREATE TABLE mailbox_oauth_intents (
 user_id TEXT NOT NULL, state_hash TEXT NOT NULL, connection_id TEXT,
 connection_generation INTEGER, credential_version INTEGER,
 PRIMARY KEY(user_id,state_hash),
 FOREIGN KEY(user_id,state_hash) REFERENCES oauth_states(user_id,state_hash) ON DELETE CASCADE,
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((connection_id IS NULL AND connection_generation IS NULL AND credential_version IS NULL) OR
 (connection_id IS NOT NULL AND connection_generation IS NOT NULL AND credential_version IS NOT NULL AND connection_generation>0 AND credential_version>=0))
);
CREATE TABLE mailbox_refresh_leases (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 lease_id TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 connection_generation INTEGER NOT NULL CHECK(connection_generation>0),
 credential_version INTEGER NOT NULL CHECK(credential_version>=0),
 fence INTEGER NOT NULL CHECK(fence>0 AND fence<=9007199254740991),
 PRIMARY KEY(user_id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((lease_id IS NULL AND lease_expires_at=0) OR (lease_id IS NOT NULL AND lease_expires_at>0))
);
