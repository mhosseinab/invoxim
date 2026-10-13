-- Archive delivery and explicit frozen membership use archive authority, independent of AI jobs.
CREATE TABLE archive_backfill_runs (
 user_id TEXT NOT NULL, id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 256),
 connection_id TEXT NOT NULL,
 storage_generation INTEGER NOT NULL CHECK(typeof(storage_generation)='integer' AND storage_generation BETWEEN 1 AND 9007199254740991),
 storage_subject TEXT NOT NULL CHECK(length(storage_subject) BETWEEN 1 AND 256),
 settings_version INTEGER NOT NULL CHECK(typeof(settings_version)='integer' AND settings_version BETWEEN 1 AND 2147483646),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
 snapshot_count INTEGER NOT NULL CHECK(typeof(snapshot_count)='integer' AND snapshot_count BETWEEN 0 AND 100),
 cursor_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cursor_ordinal)='integer' AND cursor_ordinal BETWEEN 0 AND 100 AND cursor_ordinal<=snapshot_count),
 has_more INTEGER NOT NULL CHECK(has_more IN (0,1)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','admission_complete','canceled')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 2147483646),
 lease_id TEXT CHECK(lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 256),
 lease_expires_at INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_expires_at)='integer' AND lease_expires_at BETWEEN 0 AND 9007199254740991),
 fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fence)='integer' AND fence BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,id), UNIQUE(id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((lease_id IS NULL AND lease_expires_at=0) OR (lease_id IS NOT NULL AND lease_expires_at>0)),
 CHECK(state='pending' OR lease_id IS NULL)
);
CREATE UNIQUE INDEX archive_backfill_active ON archive_backfill_runs(user_id) WHERE state='pending';
CREATE INDEX archive_backfill_due ON archive_backfill_runs(state,lease_expires_at,id);

CREATE TABLE archive_backfill_items (
 user_id TEXT NOT NULL, run_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 100),
 document_id TEXT NOT NULL,
 PRIMARY KEY(user_id,run_id,ordinal), UNIQUE(user_id,run_id,document_id),
 FOREIGN KEY(user_id,run_id) REFERENCES archive_backfill_runs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE
);

CREATE TABLE archive_dispatch (
 user_id TEXT NOT NULL, object_id TEXT NOT NULL,
 queue_id TEXT NOT NULL UNIQUE CHECK(length(queue_id) BETWEEN 1 AND 256),
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','retry_wait','paused','canceled','completed')),
 dispatch_at INTEGER NOT NULL CHECK(typeof(dispatch_at)='integer' AND dispatch_at BETWEEN 0 AND 9007199254740991),
 dispatched_at INTEGER CHECK(dispatched_at IS NULL OR (typeof(dispatched_at)='integer' AND dispatched_at BETWEEN 0 AND 9007199254740991)),
 dispatch_fence INTEGER NOT NULL DEFAULT 0 CHECK(typeof(dispatch_fence)='integer' AND dispatch_fence BETWEEN 0 AND 9007199254740991),
 failure_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failure_count)='integer' AND failure_count BETWEEN 0 AND 5),
 outcome_code TEXT CHECK(outcome_code IS NULL OR outcome_code IN ('completed','deferred','budget','busy','auth_required','folder_missing','file_missing','quota','unsupported','source_missing','conflict','transient','canceled')),
 backfill_run_id TEXT,
 PRIMARY KEY(user_id,object_id),
 FOREIGN KEY(user_id,object_id) REFERENCES archive_objects(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,backfill_run_id) REFERENCES archive_backfill_runs(user_id,id)
);
CREATE INDEX archive_dispatch_due ON archive_dispatch(status,dispatch_at,dispatched_at,queue_id);
