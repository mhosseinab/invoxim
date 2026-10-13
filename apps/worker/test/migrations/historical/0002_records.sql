CREATE TABLE profiles (
 user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting')),
 reporting_currency TEXT NOT NULL DEFAULT 'EUR', timezone TEXT NOT NULL DEFAULT 'UTC',
 onboarding_version INTEGER NOT NULL DEFAULT 1, onboarding_completed_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE connections (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('mailbox','storage')), provider TEXT NOT NULL,
 provider_subject TEXT NOT NULL, display_address TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'connected', generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 scopes TEXT NOT NULL DEFAULT '[]', credential_ciphertext TEXT, credential_key_version INTEGER,
 next_sync_at INTEGER, PRIMARY KEY(user_id,id), UNIQUE(user_id,kind,provider,provider_subject)
);
CREATE TABLE processing_consents (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 disclosure_version INTEGER NOT NULL, inference_destination TEXT NOT NULL, parser_destination TEXT NOT NULL,
 ai_settings_revision INTEGER NOT NULL, accepted_at INTEGER NOT NULL, revoked_at INTEGER,
 background_authorized INTEGER NOT NULL CHECK(background_authorized IN (0,1)),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);
CREATE TABLE import_runs (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, consent_id TEXT NOT NULL,
 connection_generation INTEGER NOT NULL, frozen_start TEXT NOT NULL, frozen_cutoff TEXT NOT NULL,
 timezone TEXT NOT NULL, request_fingerprint TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'queued',
 discovered_count INTEGER NOT NULL DEFAULT 0 CHECK(discovered_count>=0),
 processed_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_count>=0), first_usable_at INTEGER,
 started_at INTEGER NOT NULL, completed_at INTEGER, pause_reason TEXT,
 PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id), UNIQUE(user_id,request_fingerprint),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,consent_id,connection_id) REFERENCES processing_consents(user_id,id,connection_id)
);
CREATE TABLE sync_states (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, import_run_id TEXT,
 scope_key TEXT NOT NULL, sync_kind TEXT NOT NULL CHECK(sync_kind IN ('backfill','incremental')),
 run_key TEXT NOT NULL, slice_key TEXT NOT NULL CHECK(slice_key IN ('recent','older','live')),
 frozen_start TEXT, frozen_cutoff TEXT, page_token TEXT, history_cursor TEXT, last_discovery_at INTEGER,
 stage TEXT NOT NULL DEFAULT 'queued', PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id),
 UNIQUE(user_id,connection_id,scope_key,sync_kind,run_key,slice_key),
 CHECK((sync_kind='incremental' AND import_run_id IS NULL AND run_key='live' AND slice_key='live') OR
 (sync_kind='backfill' AND import_run_id IS NOT NULL AND run_key=import_run_id AND slice_key IN ('recent','older') AND frozen_start IS NOT NULL AND frozen_cutoff IS NOT NULL)),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,import_run_id,connection_id) REFERENCES import_runs(user_id,id,connection_id) ON DELETE CASCADE
);
CREATE TABLE source_messages (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 received_at INTEGER NOT NULL, processing_status TEXT NOT NULL DEFAULT 'discovered', generation INTEGER NOT NULL,
 PRIMARY KEY(user_id,id), UNIQUE(user_id,connection_id,provider_message_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);
CREATE TABLE documents (
 id TEXT NOT NULL, user_id TEXT NOT NULL, source_message_id TEXT NOT NULL, part_key TEXT NOT NULL,
 content_hash TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=4194304),
 document_date TEXT, parse_state TEXT NOT NULL DEFAULT 'discovered', PRIMARY KEY(user_id,id),
 UNIQUE(user_id,source_message_id,part_key),
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);
CREATE TABLE observations (
 id TEXT NOT NULL, user_id TEXT NOT NULL, document_id TEXT NOT NULL, segment_index INTEGER NOT NULL CHECK(segment_index>=0),
 extraction_fingerprint TEXT NOT NULL, extraction_version INTEGER NOT NULL,
 evidence_code TEXT NOT NULL CHECK(evidence_code IN ('explicitly-paid','completed-refund','invoice-only','manual-confirmation','unknown')),
 normalized_fields TEXT NOT NULL CHECK(length(normalized_fields)<=4000 AND json_valid(normalized_fields) AND COALESCE(json_type(normalized_fields,'$.schemaVersion')='integer' AND json_extract(normalized_fields,'$.schemaVersion')=1,0) AND json_remove(normalized_fields,'$.schemaVersion','$.merchant','$.date','$.totalMinor','$.currency')='{}'),
 review_state TEXT NOT NULL CHECK(review_state IN ('accepted','needs_review')),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,document_id,segment_index,extraction_fingerprint),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE
);
CREATE TABLE purchases (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 merchant_raw TEXT NOT NULL, merchant_normalized TEXT NOT NULL, invoice_ref TEXT, order_ref TEXT,
 document_date TEXT NOT NULL, total_minor INTEGER CHECK(total_minor IS NULL OR (typeof(total_minor)='integer' AND total_minor>=0 AND total_minor<=9000000000000)),
 currency TEXT, category TEXT NOT NULL DEFAULT 'other',
 payment_state TEXT NOT NULL CHECK(payment_state IN ('unknown','unpaid','partially_paid','paid')),
 fulfillment_state TEXT NOT NULL DEFAULT 'unknown', record_status TEXT NOT NULL DEFAULT 'active',
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(user_id,id)
);
CREATE TABLE purchase_evidence (
 user_id TEXT NOT NULL, purchase_id TEXT NOT NULL, observation_id TEXT NOT NULL, relationship TEXT NOT NULL,
 PRIMARY KEY(user_id,purchase_id,observation_id), UNIQUE(user_id,observation_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id)
);
CREATE TABLE ledger_entries (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 purchase_id TEXT, observation_id TEXT NOT NULL, business_event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('payment','refund')), amount_minor INTEGER NOT NULL
 CHECK(typeof(amount_minor)='integer' AND amount_minor>=0 AND amount_minor<=9000000000000),
 currency TEXT NOT NULL, event_date TEXT NOT NULL, date_basis TEXT NOT NULL,
 eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), version INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,id), UNIQUE(user_id,business_event_key),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id)
);
CREATE TABLE jobs (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, sync_state_id TEXT, consent_id TEXT NOT NULL,
 connection_generation INTEGER NOT NULL, type TEXT NOT NULL, dedupe_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ready','leased','retry_wait','paused_budget','paused_auth','completed','terminal','canceled')),
 dispatch_at INTEGER NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_expires_at INTEGER,
 fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0), outcome_code TEXT,
 PRIMARY KEY(user_id,id), UNIQUE(id), UNIQUE(user_id,dedupe_key),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,sync_state_id,connection_id) REFERENCES sync_states(user_id,id,connection_id),
 FOREIGN KEY(user_id,consent_id,connection_id) REFERENCES processing_consents(user_id,id,connection_id)
);
