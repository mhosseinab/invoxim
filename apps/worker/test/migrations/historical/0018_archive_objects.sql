CREATE TABLE archive_objects (
 id TEXT NOT NULL, user_id TEXT NOT NULL,
 document_id TEXT NOT NULL, source_message_id TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 part_key TEXT NOT NULL, document_hash TEXT NOT NULL, document_mime TEXT NOT NULL, document_size INTEGER NOT NULL,
 mailbox_connection_id TEXT NOT NULL, mailbox_generation INTEGER NOT NULL,
 storage_connection_id TEXT NOT NULL, storage_generation INTEGER NOT NULL, storage_subject TEXT NOT NULL,
 settings_version INTEGER NOT NULL CHECK(typeof(settings_version)='integer' AND settings_version BETWEEN 1 AND 2147483646),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','archived')),
 planned_file_id TEXT, parent_id TEXT, workspace_marker TEXT, original_mime TEXT, original_size INTEGER, original_sha256 TEXT,
 remote_id TEXT, archived_at INTEGER,
 lease_id TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fence)='integer' AND fence BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,document_id,storage_connection_id),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,storage_connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK(typeof(mailbox_generation)='integer' AND mailbox_generation>0 AND typeof(storage_generation)='integer' AND storage_generation>0),
 CHECK((lease_id IS NULL AND lease_expires_at=0) OR (lease_id IS NOT NULL AND typeof(lease_expires_at)='integer' AND lease_expires_at BETWEEN 1 AND 9007199254740991 AND fence>0)),
 CHECK((planned_file_id IS NULL AND parent_id IS NULL AND workspace_marker IS NULL AND original_mime IS NULL AND original_size IS NULL AND original_sha256 IS NULL) OR
 (planned_file_id IS NOT NULL AND length(planned_file_id) BETWEEN 1 AND 256 AND parent_id IS NOT NULL AND length(parent_id) BETWEEN 1 AND 256 AND workspace_marker IS NOT NULL AND length(workspace_marker) BETWEEN 1 AND 120 AND original_mime IS NOT NULL AND original_mime IN ('application/pdf','image/jpeg','image/png','message/rfc822') AND original_size IS NOT NULL AND typeof(original_size)='integer' AND original_size BETWEEN 1 AND 9007199254740991 AND original_sha256 IS NOT NULL AND length(original_sha256)=64 AND original_sha256 NOT GLOB '*[^0-9a-f]*')),
 CHECK((state='pending' AND remote_id IS NULL AND archived_at IS NULL) OR (state='archived' AND remote_id IS NOT NULL AND planned_file_id IS NOT NULL AND remote_id=planned_file_id AND typeof(archived_at)='integer' AND archived_at>=0 AND lease_id IS NULL))
);
CREATE INDEX archive_objects_pending ON archive_objects(user_id,state,lease_expires_at,id);
