ALTER TABLE processing_consents ADD COLUMN accepted_configuration_digest TEXT CHECK(accepted_configuration_digest IS NULL OR (length(accepted_configuration_digest)=64 AND accepted_configuration_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE processing_consents ADD COLUMN disclosure_digest TEXT CHECK(disclosure_digest IS NULL OR (length(disclosure_digest)=64 AND disclosure_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE import_runs ADD COLUMN onboarding_start_date TEXT CHECK(onboarding_start_date IS NULL OR (length(onboarding_start_date)=10 AND onboarding_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
ALTER TABLE import_runs ADD COLUMN onboarding_end_date TEXT CHECK(onboarding_end_date IS NULL OR (length(onboarding_end_date)=10 AND onboarding_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
ALTER TABLE import_runs ADD COLUMN onboarding_reporting_currency TEXT CHECK(onboarding_reporting_currency IS NULL OR onboarding_reporting_currency IN ('EUR','USD','GBP','CHF','JPY','KWD'));
ALTER TABLE import_runs ADD COLUMN onboarding_interval_key TEXT CHECK(onboarding_interval_key IS NULL OR (length(onboarding_interval_key)=64 AND onboarding_interval_key NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX onboarding_run_interval ON import_runs(user_id,connection_id,onboarding_interval_key,started_at);
CREATE TABLE onboarding_commands (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 key_hash TEXT NOT NULL CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
 body_hash TEXT NOT NULL CHECK(length(body_hash)=64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
 import_run_id TEXT,
 result_json TEXT NOT NULL CHECK(length(result_json)<=1000 AND json_valid(result_json)),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 PRIMARY KEY(user_id,key_hash),
 FOREIGN KEY(user_id,import_run_id) REFERENCES import_runs(user_id,id) ON DELETE CASCADE
);

-- A new account deletion leaf changes stage numbering. Restart only account cleanup.
UPDATE lifecycle_deletions SET stage=0 WHERE scope='account';
