ALTER TABLE ai_settings ADD COLUMN mode TEXT CHECK(mode IN ('hosted','byok'));
ALTER TABLE ai_settings ADD COLUMN provider_id TEXT;
ALTER TABLE ai_settings ADD COLUMN model_id TEXT;
ALTER TABLE ai_settings ADD COLUMN config_version TEXT;
ALTER TABLE ai_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<=2147483646);
ALTER TABLE ai_settings ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(consent_version)='integer' AND consent_version>=0 AND consent_version<=2147483646 AND ((mode IS NULL AND provider_id IS NULL AND model_id IS NULL AND config_version IS NULL) OR (mode IS NOT NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL AND config_version IS NOT NULL AND length(provider_id) BETWEEN 1 AND 120 AND length(model_id) BETWEEN 1 AND 120 AND length(config_version) BETWEEN 1 AND 120)));
CREATE TABLE usage_buckets (
 scope TEXT NOT NULL CHECK(scope IN ('tenant','global')),owner_key TEXT NOT NULL,user_id TEXT REFERENCES profiles(user_id) ON DELETE CASCADE,
 period_kind TEXT NOT NULL CHECK(period_kind IN ('day','month')),period_start TEXT NOT NULL,
 documents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(documents)='integer' AND documents>=0 AND documents<=9000000000000),
 reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_units)='integer' AND reserved_units>=0 AND reserved_units<=9000000000000),
 spent_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(spent_units)='integer' AND spent_units>=0 AND spent_units<=9000000000000),
 reserved_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_usd_micros)='integer' AND reserved_usd_micros>=0 AND reserved_usd_micros<=9000000000000),
 spent_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK(typeof(spent_usd_micros)='integer' AND spent_usd_micros>=0 AND spent_usd_micros<=9000000000000),
 blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
 PRIMARY KEY(scope,owner_key,period_kind,period_start),
 CHECK((scope='tenant' AND user_id IS NOT NULL AND owner_key=user_id) OR (scope='global' AND user_id IS NULL AND owner_key='operator'))
);
CREATE TABLE ai_extractions (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,run_key TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('extraction','synthetic-test')),document_id TEXT,session_id TEXT,
 content_hash TEXT NOT NULL,extraction_version TEXT NOT NULL,config_fingerprint TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('hosted','byok')),destination_id TEXT NOT NULL,model_id TEXT NOT NULL,config_version TEXT NOT NULL,settings_revision INTEGER NOT NULL,
 generation INTEGER NOT NULL,credential_version INTEGER NOT NULL,reservation_nonce TEXT NOT NULL,
 result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=65536)),
 completed_at INTEGER,created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,run_key),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,session_id) REFERENCES "session"(userId,id) ON DELETE CASCADE,
 CHECK((purpose='extraction' AND document_id IS NOT NULL AND session_id IS NULL) OR (purpose='synthetic-test' AND document_id IS NULL AND session_id IS NOT NULL)),
 CHECK((result_json IS NULL AND completed_at IS NULL) OR (result_json IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE usage_events (
 user_id TEXT NOT NULL,attempt_id TEXT NOT NULL,run_key TEXT NOT NULL,attempt_number INTEGER NOT NULL CHECK(attempt_number IN (1,2)),
 purpose TEXT NOT NULL CHECK(purpose IN ('extraction','synthetic-test')),job_id TEXT,session_id TEXT,
 mode TEXT NOT NULL CHECK(mode IN ('hosted','byok')),destination_id TEXT NOT NULL,model_id TEXT NOT NULL,
 price_snapshot TEXT NOT NULL CHECK(json_valid(price_snapshot) AND length(price_snapshot)<=4096),
 day_start TEXT NOT NULL,month_start TEXT NOT NULL,
 reserved_units INTEGER NOT NULL CHECK(typeof(reserved_units)='integer' AND reserved_units>0 AND reserved_units<=9000000000000),
 reserved_usd_micros INTEGER NOT NULL CHECK(typeof(reserved_usd_micros)='integer' AND reserved_usd_micros>=0 AND reserved_usd_micros<=9000000000000),
 actual_units TEXT,actual_usd_micros TEXT,usage_json TEXT CHECK(usage_json IS NULL OR (json_valid(usage_json) AND length(usage_json)<=256)),
 state TEXT NOT NULL CHECK(state IN ('reserved','sent','known','uncertain','not-sent','overrun')),
 reservation_nonce TEXT NOT NULL,settlement_nonce TEXT,cooldown_until INTEGER,created_at INTEGER NOT NULL,settled_at INTEGER,
 PRIMARY KEY(user_id,attempt_id),UNIQUE(user_id,run_key,attempt_number),
 FOREIGN KEY(user_id,run_key) REFERENCES ai_extractions(user_id,run_key) ON DELETE CASCADE,
 FOREIGN KEY(user_id,job_id) REFERENCES jobs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,session_id) REFERENCES "session"(userId,id) ON DELETE CASCADE,
 CHECK((purpose='extraction' AND job_id IS NOT NULL AND session_id IS NULL) OR (purpose='synthetic-test' AND job_id IS NULL AND session_id IS NOT NULL)),
 CHECK(actual_units IS NULL OR (typeof(actual_units)='text' AND length(actual_units) BETWEEN 1 AND 32 AND actual_units NOT GLOB '*[^0-9]*')),
 CHECK(actual_usd_micros IS NULL OR (typeof(actual_usd_micros)='text' AND length(actual_usd_micros) BETWEEN 1 AND 32 AND actual_usd_micros NOT GLOB '*[^0-9]*'))
);
CREATE INDEX ai_events_tenant_cooldown ON usage_events(user_id,destination_id,model_id,cooldown_until DESC);

CREATE INDEX ai_events_tenant_state ON usage_events(user_id,state);
CREATE INDEX usage_global_blocked ON usage_buckets(scope,blocked);

CREATE TABLE hosted_ai_cooldowns (
 destination_id TEXT NOT NULL CHECK(length(destination_id) BETWEEN 1 AND 120),
 model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 120),
 cooldown_until INTEGER NOT NULL CHECK(typeof(cooldown_until)='integer' AND cooldown_until>=0 AND cooldown_until<=9007199254740991),
 PRIMARY KEY(destination_id,model_id)
);
