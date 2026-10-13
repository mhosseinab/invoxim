CREATE TABLE storage_oauth_intents (
 user_id TEXT NOT NULL, state_hash TEXT NOT NULL, connection_id TEXT,
 connection_generation INTEGER, credential_version INTEGER,
 archive_settings_version INTEGER NOT NULL CHECK(typeof(archive_settings_version)='integer' AND archive_settings_version BETWEEN 0 AND 2147483646),
 PRIMARY KEY(user_id,state_hash),
 FOREIGN KEY(user_id,state_hash) REFERENCES oauth_states(user_id,state_hash) ON DELETE CASCADE,
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((connection_id IS NULL AND connection_generation IS NULL AND credential_version IS NULL) OR
 (connection_id IS NOT NULL AND connection_generation IS NOT NULL AND credential_version IS NOT NULL AND typeof(connection_generation)='integer' AND connection_generation>0 AND typeof(credential_version)='integer' AND credential_version>=0))
);
CREATE TABLE storage_refresh_leases (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 lease_id TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 connection_generation INTEGER NOT NULL CHECK(typeof(connection_generation)='integer' AND connection_generation>0),
 credential_version INTEGER NOT NULL CHECK(typeof(credential_version)='integer' AND credential_version>=0),
 fence INTEGER NOT NULL CHECK(typeof(fence)='integer' AND fence>0 AND fence<=9007199254740991),
 PRIMARY KEY(user_id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK(typeof(lease_expires_at)='integer' AND ((lease_id IS NULL AND lease_expires_at=0) OR (lease_id IS NOT NULL AND lease_expires_at>0 AND lease_expires_at<=9007199254740991)))
);
CREATE TABLE archive_settings (
 user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 connection_id TEXT, connection_generation INTEGER,
 disclosure_version INTEGER, accepted_at INTEGER,
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id),
 CHECK((enabled=0 AND connection_id IS NULL AND connection_generation IS NULL AND disclosure_version IS NULL AND accepted_at IS NULL) OR
 (enabled=1 AND connection_id IS NOT NULL AND connection_generation IS NOT NULL AND typeof(connection_generation)='integer' AND connection_generation>0 AND disclosure_version IS NOT NULL AND typeof(disclosure_version)='integer' AND disclosure_version=1 AND accepted_at IS NOT NULL AND typeof(accepted_at)='integer' AND accepted_at BETWEEN 0 AND 9007199254740991))
);
