CREATE TABLE archive_folders (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 storage_subject TEXT NOT NULL CHECK(length(storage_subject) BETWEEN 1 AND 256),
 planned_file_id TEXT NOT NULL CHECK(length(planned_file_id) BETWEEN 1 AND 128 AND planned_file_id NOT GLOB '*[^A-Za-z0-9_-]*'),
 workspace_marker TEXT NOT NULL CHECK(length(workspace_marker) BETWEEN 16 AND 96 AND workspace_marker NOT GLOB '*[^A-Za-z0-9_-]*'),
 state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','ready')), verified_at INTEGER,
 lease_id TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 lease_settings_version INTEGER, lease_generation INTEGER,
 fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fence)='integer' AND fence BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id),
 CHECK((state='planned' AND verified_at IS NULL) OR (state='ready' AND verified_at IS NOT NULL AND typeof(verified_at)='integer' AND verified_at BETWEEN 0 AND 9007199254740991)),
 CHECK((lease_id IS NULL AND lease_expires_at=0 AND lease_settings_version IS NULL AND lease_generation IS NULL) OR
 (lease_id IS NOT NULL AND length(lease_id) BETWEEN 1 AND 256 AND typeof(lease_expires_at)='integer' AND lease_expires_at BETWEEN 1 AND 9007199254740991 AND lease_settings_version IS NOT NULL AND typeof(lease_settings_version)='integer' AND lease_settings_version BETWEEN 1 AND 2147483646 AND lease_generation IS NOT NULL AND typeof(lease_generation)='integer' AND lease_generation BETWEEN 1 AND 9007199254740991 AND fence>0))
);
