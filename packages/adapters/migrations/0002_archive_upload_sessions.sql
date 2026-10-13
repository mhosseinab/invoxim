-- Add resumable-upload metadata without changing the consolidated initial baseline.
-- Only encrypted session references are retained. Original bytes remain transient.
CREATE TABLE archive_upload_sessions (
 user_id TEXT NOT NULL,
 object_id TEXT NOT NULL,
 reference_ciphertext TEXT NOT NULL CHECK(length(reference_ciphertext) BETWEEN 1 AND 40000),
 key_version INTEGER NOT NULL CHECK(typeof(key_version)='integer' AND key_version BETWEEN 1 AND 2147483646),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 1 AND 9007199254740991),
 uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(uploaded_bytes)='integer' AND uploaded_bytes BETWEEN 0 AND 16777216),
 PRIMARY KEY(user_id,object_id),
 FOREIGN KEY(user_id,object_id) REFERENCES archive_objects(user_id,id) ON DELETE CASCADE
);
