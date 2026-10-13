ALTER TABLE processing_consents ADD COLUMN query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad'));
ALTER TABLE import_runs ADD COLUMN query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad'));
ALTER TABLE sync_states ADD COLUMN discovery_version INTEGER NOT NULL DEFAULT 0 CHECK(discovery_version>=0 AND discovery_version<=9007199254740991);
ALTER TABLE sync_states ADD COLUMN query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad'));
ALTER TABLE sync_states ADD COLUMN pending_ids TEXT;
ALTER TABLE sync_states ADD COLUMN pending_deleted_ids TEXT;
ALTER TABLE sync_states ADD COLUMN pending_next_token TEXT;
ALTER TABLE sync_states ADD COLUMN pending_history_id TEXT;
ALTER TABLE sync_states ADD COLUMN enumerated_count INTEGER NOT NULL DEFAULT 0 CHECK(enumerated_count>=0);
ALTER TABLE sync_states ADD COLUMN matched_count INTEGER NOT NULL DEFAULT 0 CHECK(matched_count>=0);
ALTER TABLE sync_states ADD COLUMN unknown_count INTEGER NOT NULL DEFAULT 0 CHECK(unknown_count>=0);
ALTER TABLE sync_states ADD COLUMN retry_at INTEGER;
ALTER TABLE sync_states ADD COLUMN coverage_code TEXT NOT NULL DEFAULT 'filtered_query' CHECK(coverage_code IN ('filtered_query','broad_metadata','candidate_unknown','recovering_history'));
ALTER TABLE sync_states ADD COLUMN recovery_anchor TEXT;
ALTER TABLE source_messages ADD COLUMN available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1));
CREATE TABLE discovery_source_jobs (
 user_id TEXT NOT NULL,job_id TEXT NOT NULL,source_message_id TEXT NOT NULL,
 PRIMARY KEY(user_id,job_id),
 FOREIGN KEY(user_id,job_id) REFERENCES jobs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);
CREATE TABLE discovery_run_sources (
 user_id TEXT NOT NULL,import_run_id TEXT NOT NULL,source_message_id TEXT NOT NULL,candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('matched','unknown')),
 PRIMARY KEY(user_id,import_run_id,source_message_id),
 FOREIGN KEY(user_id,import_run_id) REFERENCES import_runs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);
CREATE INDEX discovery_jobs_source ON discovery_source_jobs(user_id,source_message_id);
CREATE INDEX discovery_sources_run ON discovery_run_sources(user_id,import_run_id,candidate_kind,source_message_id);
ALTER TABLE sync_states ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0 AND consecutive_failures<=5);
ALTER TABLE sync_states ADD COLUMN history_reset_count INTEGER NOT NULL DEFAULT 0 CHECK(history_reset_count>=0);
CREATE TABLE discovery_seen_refs (
 user_id TEXT NOT NULL,sync_state_id TEXT NOT NULL,provider_message_id TEXT NOT NULL,candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('matched','unknown','excluded')),
 PRIMARY KEY(user_id,sync_state_id,provider_message_id),
 FOREIGN KEY(user_id,sync_state_id) REFERENCES sync_states(user_id,id) ON DELETE CASCADE
);
