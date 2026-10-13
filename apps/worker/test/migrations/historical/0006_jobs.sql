ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 1 CHECK(priority IN (0,1,2));
ALTER TABLE jobs ADD COLUMN dispatched_at INTEGER;
ALTER TABLE connections ADD COLUMN manual_sync_at INTEGER;
CREATE INDEX jobs_tenant_ready ON jobs(user_id,status,priority,dispatch_at,id);
CREATE INDEX jobs_tenant_leases ON jobs(user_id,status,lease_expires_at,id);
CREATE INDEX jobs_global_leases ON jobs(status,lease_expires_at,id);
CREATE INDEX profiles_schedule_page ON profiles(status,user_id);
CREATE TABLE scheduler_cursors(kind TEXT PRIMARY KEY CHECK(kind IN ('dispatch','schedule','recovery')),last_user_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);
INSERT INTO scheduler_cursors(kind) VALUES('dispatch'),('schedule'),('recovery');

ALTER TABLE profiles ADD COLUMN job_recovery_cursor TEXT NOT NULL DEFAULT '';
CREATE INDEX jobs_tenant_recovery ON jobs(user_id,id,status);
CREATE INDEX jobs_dispatchable ON jobs(user_id,priority,dispatch_at,id) WHERE status IN ('ready','retry_wait');
CREATE INDEX connections_tenant_due ON connections(user_id,scheduling_state,next_sync_at,id);
CREATE INDEX consents_connection_background ON processing_consents(user_id,connection_id,accepted_at DESC,id) WHERE revoked_at IS NULL AND background_authorized=1;
CREATE INDEX jobs_pending_sync ON jobs(user_id,connection_id,connection_generation,id) WHERE type='sync' AND status IN ('ready','leased','retry_wait');
