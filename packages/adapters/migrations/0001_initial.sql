-- Consolidated baseline candidate: native compatibility verification required.
-- Existing populated databases must NOT reapply this initial schema.

CREATE TABLE "account" ("id" TEXT PRIMARY KEY NOT NULL,
"accountId" TEXT NOT NULL,
"providerId" TEXT NOT NULL,
"userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
"accessToken" TEXT,
"refreshToken" TEXT,
"idToken" TEXT,
"accessTokenExpiresAt" INTEGER,
"refreshTokenExpiresAt" INTEGER,
"scope" TEXT,
"password" TEXT,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL);

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

CREATE TABLE ai_settings (
 user_id TEXT PRIMARY KEY REFERENCES profiles(user_id) ON DELETE CASCADE,
 id TEXT NOT NULL DEFAULT 'primary' CHECK(id='primary'),
 encrypted_key TEXT, key_version INTEGER, credential_version INTEGER NOT NULL DEFAULT 0 CHECK(credential_version>=0),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')), mode TEXT CHECK(mode IN ('hosted','byok')), provider_id TEXT, model_id TEXT, config_version TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<=2147483646), consent_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(consent_version)='integer' AND consent_version>=0 AND consent_version<=2147483646 AND ((mode IS NULL AND provider_id IS NULL AND model_id IS NULL AND config_version IS NULL) OR (mode IS NOT NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL AND config_version IS NOT NULL AND length(provider_id) BETWEEN 1 AND 120 AND length(model_id) BETWEEN 1 AND 120 AND length(config_version) BETWEEN 1 AND 120))),
 UNIQUE(user_id,id),
 CHECK((encrypted_key IS NULL AND key_version IS NULL) OR (encrypted_key IS NOT NULL AND key_version IS NOT NULL AND key_version>0))
);

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

CREATE TABLE connections (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('mailbox','storage')), provider TEXT NOT NULL,
 provider_subject TEXT NOT NULL, display_address TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'connected', generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
 scopes TEXT NOT NULL DEFAULT '[]', credential_ciphertext TEXT, credential_key_version INTEGER,
 next_sync_at INTEGER, scheduling_state TEXT NOT NULL DEFAULT 'awaiting_import' CHECK(scheduling_state IN ('awaiting_import','active','paused')), credential_version INTEGER NOT NULL DEFAULT 0 CHECK(credential_version>=0 AND ((credential_ciphertext IS NULL AND credential_key_version IS NULL) OR (credential_ciphertext IS NOT NULL AND credential_key_version IS NOT NULL AND credential_key_version>0))), manual_sync_at INTEGER, PRIMARY KEY(user_id,id), UNIQUE(user_id,kind,provider,provider_subject)
);

CREATE TABLE correction_audit (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,field TEXT,
 before_json TEXT NOT NULL CHECK(json_valid(before_json) AND length(before_json)<=1000),after_json TEXT NOT NULL CHECK(json_valid(after_json) AND length(after_json)<=1000),created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,id)
);

CREATE TABLE correction_commands (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,route TEXT NOT NULL,key TEXT NOT NULL,body_hash TEXT NOT NULL,executor TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=65536),created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,route,key)
);

CREATE TABLE discovery_run_sources (
 user_id TEXT NOT NULL,import_run_id TEXT NOT NULL,source_message_id TEXT NOT NULL,candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('matched','unknown')),
 PRIMARY KEY(user_id,import_run_id,source_message_id),
 FOREIGN KEY(user_id,import_run_id) REFERENCES import_runs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);

CREATE TABLE discovery_seen_refs (
 user_id TEXT NOT NULL,sync_state_id TEXT NOT NULL,provider_message_id TEXT NOT NULL,candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('matched','unknown','excluded')),
 PRIMARY KEY(user_id,sync_state_id,provider_message_id),
 FOREIGN KEY(user_id,sync_state_id) REFERENCES sync_states(user_id,id) ON DELETE CASCADE
);

CREATE TABLE discovery_source_jobs (
 user_id TEXT NOT NULL,job_id TEXT NOT NULL,source_message_id TEXT NOT NULL, pipeline_stage TEXT NOT NULL DEFAULT 'parse' CHECK(pipeline_stage IN ('parse','infer','reconcile')), document_index INTEGER NOT NULL DEFAULT 0 CHECK(typeof(document_index)='integer' AND document_index BETWEEN 0 AND 63), extraction_fingerprint TEXT CHECK(extraction_fingerprint IS NULL OR (length(extraction_fingerprint)=64 AND extraction_fingerprint NOT GLOB '*[^0-9a-f]*')),
 PRIMARY KEY(user_id,job_id),
 FOREIGN KEY(user_id,job_id) REFERENCES jobs(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);

CREATE TABLE documents (
 id TEXT NOT NULL, user_id TEXT NOT NULL, source_message_id TEXT NOT NULL, part_key TEXT NOT NULL,
 content_hash TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=4194304),
 document_date TEXT, parse_state TEXT NOT NULL DEFAULT 'discovered', pipeline_index INTEGER CHECK(pipeline_index IS NULL OR (typeof(pipeline_index)='integer' AND pipeline_index BETWEEN 0 AND 63)), parser_version TEXT CHECK(parser_version IS NULL OR length(parser_version) BETWEEN 1 AND 120), parse_code TEXT CHECK(parse_code IS NULL OR length(parse_code) BETWEEN 1 AND 80), PRIMARY KEY(user_id,id),
 UNIQUE(user_id,source_message_id,part_key),
 FOREIGN KEY(user_id,source_message_id) REFERENCES source_messages(user_id,id) ON DELETE CASCADE
);

CREATE TABLE entry_valuations (
 user_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 reporting_currency TEXT NOT NULL CHECK(length(reporting_currency)=3 AND reporting_currency NOT GLOB '*[^A-Z]*'),
 profile_version INTEGER NOT NULL CHECK(typeof(profile_version)='integer' AND profile_version BETWEEN 1 AND 2147483646),
 entry_version INTEGER NOT NULL CHECK(typeof(entry_version)='integer' AND entry_version BETWEEN 1 AND 2147483646),
 calculation_version TEXT NOT NULL CHECK(calculation_version='fx-v1'),
 policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
 policy_source TEXT NOT NULL CHECK(length(policy_source) BETWEEN 1 AND 80),
 max_prior_age_days INTEGER NOT NULL CHECK(typeof(max_prior_age_days)='integer' AND max_prior_age_days BETWEEN 0 AND 31),
 original_kind TEXT NOT NULL CHECK(original_kind IN ('payment','refund')),
 original_minor INTEGER NOT NULL CHECK(typeof(original_minor)='integer' AND original_minor BETWEEN 0 AND 9000000000000),
 original_currency TEXT NOT NULL,
 original_event_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('converted','unconverted')),
 signed_minor TEXT CHECK(signed_minor IS NULL OR (typeof(signed_minor)='text' AND (signed_minor='0' OR (signed_minor NOT GLOB '*[^0-9]*' AND substr(signed_minor,1,1) BETWEEN '1' AND '9' AND length(signed_minor)<=19 AND (length(signed_minor)<19 OR signed_minor<='9223372036854775807')) OR (substr(signed_minor,1,1)='-' AND substr(signed_minor,2) NOT GLOB '*[^0-9]*' AND substr(signed_minor,2,1) BETWEEN '1' AND '9' AND length(signed_minor)<=20 AND (length(signed_minor)<20 OR substr(signed_minor,2)<='9223372036854775807'))))),
 basis TEXT CHECK(basis IN ('identity','reference')),
 reason TEXT CHECK(reason IN ('rate_missing','currency_unsupported','rate_future','rate_stale','quote_mismatch','source_mismatch','invalid_quote','magnitude_overflow')),
 rate_id TEXT REFERENCES fx_rates(id),
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,entry_id,reporting_currency,profile_version,entry_version,calculation_version,policy_hash),
 FOREIGN KEY(user_id,entry_id) REFERENCES ledger_entries(user_id,id) ON DELETE CASCADE,
 CHECK((status='converted' AND signed_minor IS NOT NULL AND basis IS NOT NULL AND reason IS NULL AND ((basis='identity' AND rate_id IS NULL AND original_currency=reporting_currency) OR (basis='reference' AND rate_id IS NOT NULL AND original_currency<>reporting_currency))) OR (status='unconverted' AND signed_minor IS NULL AND basis IS NULL AND reason IS NOT NULL)),
 CHECK(status='unconverted' OR (original_kind='payment' AND substr(signed_minor,1,1)<>'-') OR (original_kind='refund' AND (signed_minor='0' OR substr(signed_minor,1,1)='-')))
);

CREATE TABLE field_overrides (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,entity_kind TEXT NOT NULL CHECK(entity_kind IN ('purchase','entry')),entity_id TEXT NOT NULL,field TEXT NOT NULL,
 original_value_json TEXT NOT NULL CHECK(json_valid(original_value_json) AND length(original_value_json)<=1000),value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(value_json)<=1000),revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(user_id,entity_kind,entity_id,field)
);

CREATE TABLE fx_rates (
 id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
 from_currency TEXT NOT NULL CHECK(length(from_currency)=3 AND from_currency NOT GLOB '*[^A-Z]*'),
 to_currency TEXT NOT NULL CHECK(length(to_currency)=3 AND to_currency NOT GLOB '*[^A-Z]*'),
 requested_date TEXT NOT NULL CHECK(length(requested_date)=10),
 effective_date TEXT NOT NULL CHECK(length(effective_date)=10),
 rate TEXT NOT NULL CHECK(length(rate) BETWEEN 1 AND 31 AND rate NOT GLOB '*[^0-9.]*' AND substr(rate,1,1) BETWEEN '0' AND '9' AND substr(rate,-1,1) BETWEEN '0' AND '9' AND length(rate)-length(replace(rate,'.',''))<=1 AND replace(rate,'.','') GLOB '*[1-9]*' AND (substr(rate,1,1)<>'0' OR substr(rate,2,1)='.') AND CASE WHEN instr(rate,'.')=0 THEN length(rate)<=12 ELSE instr(rate,'.')<=13 AND length(rate)-instr(rate,'.') BETWEEN 1 AND 18 END),
 retrieved_at INTEGER NOT NULL CHECK(typeof(retrieved_at)='integer' AND retrieved_at BETWEEN 0 AND 9007199254740991),
 source_version TEXT NOT NULL CHECK(length(source_version) BETWEEN 1 AND 80),
 UNIQUE(source,from_currency,to_currency,requested_date,effective_date,source_version)
);

CREATE TABLE hosted_ai_cooldowns (
 destination_id TEXT NOT NULL CHECK(length(destination_id) BETWEEN 1 AND 120),
 model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 120),
 cooldown_until INTEGER NOT NULL CHECK(typeof(cooldown_until)='integer' AND cooldown_until>=0 AND cooldown_until<=9007199254740991),
 PRIMARY KEY(destination_id,model_id)
);

CREATE TABLE import_runs (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, consent_id TEXT NOT NULL,
 connection_generation INTEGER NOT NULL, frozen_start TEXT NOT NULL, frozen_cutoff TEXT NOT NULL,
 timezone TEXT NOT NULL, request_fingerprint TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'queued',
 discovered_count INTEGER NOT NULL DEFAULT 0 CHECK(discovered_count>=0),
 processed_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_count>=0), first_usable_at INTEGER,
 started_at INTEGER NOT NULL, completed_at INTEGER, pause_reason TEXT, query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad')), onboarding_start_date TEXT CHECK(onboarding_start_date IS NULL OR (length(onboarding_start_date)=10 AND onboarding_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')), onboarding_end_date TEXT CHECK(onboarding_end_date IS NULL OR (length(onboarding_end_date)=10 AND onboarding_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')), onboarding_reporting_currency TEXT CHECK(onboarding_reporting_currency IS NULL OR onboarding_reporting_currency IN ('EUR','USD','GBP','CHF','JPY','KWD')), onboarding_interval_key TEXT CHECK(onboarding_interval_key IS NULL OR (length(onboarding_interval_key)=64 AND onboarding_interval_key NOT GLOB '*[^0-9a-f]*')),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id), UNIQUE(user_id,request_fingerprint),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,consent_id,connection_id) REFERENCES processing_consents(user_id,id,connection_id)
);

CREATE TABLE jobs (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, sync_state_id TEXT, consent_id TEXT NOT NULL,
 connection_generation INTEGER NOT NULL, type TEXT NOT NULL, dedupe_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ready','leased','retry_wait','paused_budget','paused_auth','completed','terminal','canceled')),
 dispatch_at INTEGER NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_expires_at INTEGER,
 fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0), outcome_code TEXT, priority INTEGER NOT NULL DEFAULT 1 CHECK(priority IN (0,1,2)), dispatched_at INTEGER,
 PRIMARY KEY(user_id,id), UNIQUE(id), UNIQUE(user_id,dedupe_key),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,sync_state_id,connection_id) REFERENCES sync_states(user_id,id,connection_id),
 FOREIGN KEY(user_id,consent_id,connection_id) REFERENCES processing_consents(user_id,id,connection_id)
);

CREATE TABLE "ledger_entries" (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 purchase_id TEXT,observation_id TEXT,business_event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor>=0 AND amount_minor<=9000000000000),
 currency TEXT NOT NULL,event_date TEXT NOT NULL,date_basis TEXT NOT NULL,
 eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 origin TEXT NOT NULL DEFAULT 'source' CHECK(origin IN ('source','user-confirmed')),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,business_event_key),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id),
 CHECK((origin='source' AND observation_id IS NOT NULL) OR (origin='user-confirmed' AND observation_id IS NULL AND purchase_id IS NOT NULL))
);

CREATE TABLE ledger_match_decisions (
 user_id TEXT NOT NULL,content_hash TEXT NOT NULL,segment_index INTEGER NOT NULL CHECK(segment_index BETWEEN 0 AND 9),purchase_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('same-purchase','different-purchase')),
 PRIMARY KEY(user_id,content_hash,segment_index,purchase_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);

CREATE TABLE lifecycle_commands (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 route TEXT NOT NULL,key TEXT NOT NULL,body_hash TEXT NOT NULL,executor TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=2000),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,route,key)
);

CREATE TABLE lifecycle_deletions (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('account','connection')),target_id TEXT NOT NULL,
 request_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,stage INTEGER NOT NULL DEFAULT 0 CHECK(stage>=0),
 journal_ack INTEGER NOT NULL DEFAULT 0 CHECK(journal_ack IN (0,1)),
 PRIMARY KEY(user_id,scope,target_id)
);

CREATE TABLE mailbox_oauth_intents (
 user_id TEXT NOT NULL, state_hash TEXT NOT NULL, connection_id TEXT,
 connection_generation INTEGER, credential_version INTEGER,
 PRIMARY KEY(user_id,state_hash),
 FOREIGN KEY(user_id,state_hash) REFERENCES oauth_states(user_id,state_hash) ON DELETE CASCADE,
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((connection_id IS NULL AND connection_generation IS NULL AND credential_version IS NULL) OR
 (connection_id IS NOT NULL AND connection_generation IS NOT NULL AND credential_version IS NOT NULL AND connection_generation>0 AND credential_version>=0))
);

CREATE TABLE mailbox_refresh_leases (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 lease_id TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0,
 connection_generation INTEGER NOT NULL CHECK(connection_generation>0),
 credential_version INTEGER NOT NULL CHECK(credential_version>=0),
 fence INTEGER NOT NULL CHECK(fence>0 AND fence<=9007199254740991),
 PRIMARY KEY(user_id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 CHECK((lease_id IS NULL AND lease_expires_at=0) OR (lease_id IS NOT NULL AND lease_expires_at>0))
);

CREATE TABLE manual_purchase_evidence (
 user_id TEXT NOT NULL,purchase_id TEXT NOT NULL,document_id TEXT NOT NULL,
 PRIMARY KEY(user_id,purchase_id,document_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id)
);

CREATE TABLE oauth_states (
 state_hash TEXT PRIMARY KEY CHECK(length(state_hash)=64),
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('mailbox','storage')),
 provider TEXT NOT NULL CHECK(provider IN ('google','microsoft')), callback TEXT NOT NULL,
 pkce_ciphertext TEXT, pkce_key_version INTEGER, nonce TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+600000), consumed_at INTEGER,
 FOREIGN KEY(user_id,session_id) REFERENCES "session"(userId,id) ON DELETE CASCADE,
 CHECK((consumed_at IS NULL AND pkce_ciphertext IS NOT NULL AND pkce_key_version IS NOT NULL AND pkce_key_version>0 AND nonce IS NOT NULL) OR
 (consumed_at IS NOT NULL AND pkce_ciphertext IS NULL AND pkce_key_version IS NULL AND nonce IS NULL))
);

CREATE TABLE observations (
 id TEXT NOT NULL, user_id TEXT NOT NULL, document_id TEXT NOT NULL, segment_index INTEGER NOT NULL CHECK(segment_index>=0),
 extraction_fingerprint TEXT NOT NULL, extraction_version INTEGER NOT NULL,
 evidence_code TEXT NOT NULL CHECK(evidence_code IN ('explicitly-paid','completed-refund','invoice-only','manual-confirmation','unknown')),
 normalized_fields TEXT NOT NULL CHECK(length(normalized_fields)<=4000 AND json_valid(normalized_fields) AND COALESCE(json_type(normalized_fields,'$.schemaVersion')='integer' AND json_extract(normalized_fields,'$.schemaVersion')=1,0) AND json_remove(normalized_fields,'$.schemaVersion','$.merchant','$.date','$.totalMinor','$.currency')='{}'),
 review_state TEXT NOT NULL CHECK(review_state IN ('accepted','needs_review')), structured_fields TEXT CHECK(structured_fields IS NULL OR (length(structured_fields)<=12000 AND json_valid(structured_fields) AND COALESCE(json_type(structured_fields,'$.schemaVersion')='integer' AND json_extract(structured_fields,'$.schemaVersion')=1,0) AND json_remove(structured_fields,'$.schemaVersion','$.documentType','$.record')='{}' AND json_type(structured_fields,'$.record')='object' AND json_remove(json_extract(structured_fields,'$.record'),'$.merchant','$.documentDate','$.eventDate','$.currency','$.total','$.tax','$.invoiceNumber','$.orderReference','$.paymentReference','$.refundReference','$.category','$.paymentEvidence','$.refundEvidence','$.paymentMethodHint','$.recurringCadence','$.paymentAmount','$.refundAmount','$.storeCreditAmount','$.provenance')='{}')), merchant_key TEXT, invoice_ref TEXT, order_ref TEXT,
 PRIMARY KEY(user_id,id), UNIQUE(user_id,document_id,segment_index,extraction_fingerprint),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE
);

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

CREATE TABLE outlook_folders (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 folder_id TEXT NOT NULL CHECK(length(folder_id) BETWEEN 1 AND 256),
 parent_folder_id TEXT CHECK(parent_folder_id IS NULL OR length(parent_folder_id) BETWEEN 1 AND 256),
 child_folder_count INTEGER NOT NULL CHECK(typeof(child_folder_count)='integer' AND child_folder_count BETWEEN 0 AND 100000),
 is_hidden INTEGER NOT NULL CHECK(is_hidden IN (0,1)),
 PRIMARY KEY(user_id,connection_id,generation,folder_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);

CREATE TABLE outlook_inventory_states (
 user_id TEXT NOT NULL, connection_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 263),
 parent_folder_id TEXT CHECK(parent_folder_id IS NULL OR length(parent_folder_id) BETWEEN 1 AND 256),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
 next_link TEXT CHECK(next_link IS NULL OR length(next_link) BETWEEN 1 AND 4096),
 state TEXT NOT NULL CHECK(state IN ('pending','complete')),
 commit_id TEXT NOT NULL CHECK(length(commit_id)=36),
 PRIMARY KEY(user_id,connection_id,generation,scope_key),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);

CREATE TABLE processing_consents (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 disclosure_version INTEGER NOT NULL, inference_destination TEXT NOT NULL, parser_destination TEXT NOT NULL,
 ai_settings_revision INTEGER NOT NULL, accepted_at INTEGER NOT NULL, revoked_at INTEGER,
 background_authorized INTEGER NOT NULL CHECK(background_authorized IN (0,1)), query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad')), accepted_configuration_digest TEXT CHECK(accepted_configuration_digest IS NULL OR (length(accepted_configuration_digest)=64 AND accepted_configuration_digest NOT GLOB '*[^0-9a-f]*')), disclosure_digest TEXT CHECK(disclosure_digest IS NULL OR (length(disclosure_digest)=64 AND disclosure_digest NOT GLOB '*[^0-9a-f]*')),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);

CREATE TABLE profiles (
 user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting')),
 reporting_currency TEXT NOT NULL DEFAULT 'EUR', timezone TEXT NOT NULL DEFAULT 'UTC',
 onboarding_version INTEGER NOT NULL DEFAULT 1, onboarding_completed_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0 AND version <= 2147483646), job_recovery_cursor TEXT NOT NULL DEFAULT '');

CREATE TABLE purchase_evidence (
 user_id TEXT NOT NULL, purchase_id TEXT NOT NULL, observation_id TEXT NOT NULL, relationship TEXT NOT NULL,
 PRIMARY KEY(user_id,purchase_id,observation_id), UNIQUE(user_id,observation_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id)
);

CREATE TABLE purchase_merges (
 id TEXT NOT NULL,user_id TEXT NOT NULL,target_id TEXT NOT NULL,source_id TEXT NOT NULL,target_version INTEGER NOT NULL,source_version INTEGER NOT NULL,
 moved_json TEXT NOT NULL CHECK(json_valid(moved_json) AND length(moved_json)<=2097152),active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,target_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);

CREATE TABLE purchases (
 id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 merchant_raw TEXT NOT NULL, merchant_normalized TEXT NOT NULL, invoice_ref TEXT, order_ref TEXT,
 document_date TEXT NOT NULL, total_minor INTEGER CHECK(total_minor IS NULL OR (typeof(total_minor)='integer' AND total_minor>=0 AND total_minor<=9000000000000)),
 currency TEXT, category TEXT NOT NULL DEFAULT 'other',
 payment_state TEXT NOT NULL CHECK(payment_state IN ('unknown','unpaid','partially_paid','paid')),
 fulfillment_state TEXT NOT NULL DEFAULT 'unknown', record_status TEXT NOT NULL DEFAULT 'active',
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), lifecycle_delete_connection_id TEXT, lifecycle_recompute_connection_id TEXT, origin TEXT NOT NULL DEFAULT 'source' CHECK(origin IN ('source','user-supplied')), PRIMARY KEY(user_id,id)
);

CREATE TABLE "review_items" (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 document_id TEXT,observation_id TEXT,purchase_id TEXT,
 reason TEXT NOT NULL CHECK(reason IN ('extraction-review','incomplete-financial-facts','unknown-payment','ambiguous-event','event-conflict','invoice-conflict','purchase-conflict','possible-duplicate','unmatched-refund','refund-exceeds-payment','refund-currency-mismatch','credit-note-completion','mixed-tender','document-review','payment-allocation-review')),
 blocking_scope TEXT NOT NULL CHECK(blocking_scope IN ('financial','operational')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 missing_fields_json TEXT CHECK(missing_fields_json IS NULL OR (length(missing_fields_json)<=100 AND json_valid(missing_fields_json) AND json_type(missing_fields_json)='array' AND json_array_length(missing_fields_json) BETWEEN 1 AND 4 AND (json_array_length(missing_fields_json)<=0 OR (json_type(missing_fields_json,'$[0]')='text' AND json_extract(missing_fields_json,'$[0]') IN ('merchant','currency','total','documentDate'))) AND (json_array_length(missing_fields_json)<=1 OR (json_type(missing_fields_json,'$[1]')='text' AND json_extract(missing_fields_json,'$[1]') IN ('merchant','currency','total','documentDate'))) AND (json_array_length(missing_fields_json)<=2 OR (json_type(missing_fields_json,'$[2]')='text' AND json_extract(missing_fields_json,'$[2]') IN ('merchant','currency','total','documentDate'))) AND (json_array_length(missing_fields_json)<=3 OR (json_type(missing_fields_json,'$[3]')='text' AND json_extract(missing_fields_json,'$[3]') IN ('merchant','currency','total','documentDate'))) AND (json_array_length(missing_fields_json)<=1 OR json_extract(missing_fields_json,'$[0]') IS NOT json_extract(missing_fields_json,'$[1]')) AND (json_array_length(missing_fields_json)<=2 OR json_extract(missing_fields_json,'$[0]') IS NOT json_extract(missing_fields_json,'$[2]')) AND (json_array_length(missing_fields_json)<=3 OR json_extract(missing_fields_json,'$[0]') IS NOT json_extract(missing_fields_json,'$[3]')) AND (json_array_length(missing_fields_json)<=2 OR json_extract(missing_fields_json,'$[1]') IS NOT json_extract(missing_fields_json,'$[2]')) AND (json_array_length(missing_fields_json)<=3 OR json_extract(missing_fields_json,'$[1]') IS NOT json_extract(missing_fields_json,'$[3]')) AND (json_array_length(missing_fields_json)<=3 OR json_extract(missing_fields_json,'$[2]') IS NOT json_extract(missing_fields_json,'$[3]')))),
 CHECK(document_id IS NOT NULL OR(reason='payment-allocation-review' AND purchase_id IS NOT NULL AND observation_id IS NULL)),
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);

CREATE TABLE scheduler_cursors(kind TEXT PRIMARY KEY CHECK(kind IN ('dispatch','schedule','recovery')),last_user_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);

CREATE TABLE "session" ("id" TEXT PRIMARY KEY NOT NULL,
"expiresAt" INTEGER NOT NULL,
"token" TEXT NOT NULL UNIQUE,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL,
"ipAddress" TEXT,
"userAgent" TEXT,
"userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE);

CREATE TABLE source_messages (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 received_at INTEGER NOT NULL, processing_status TEXT NOT NULL DEFAULT 'discovered', generation INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
 PRIMARY KEY(user_id,id), UNIQUE(user_id,connection_id,provider_message_id),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE
);

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

CREATE TABLE sync_states (
 id TEXT NOT NULL, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, import_run_id TEXT,
 scope_key TEXT NOT NULL, sync_kind TEXT NOT NULL CHECK(sync_kind IN ('backfill','incremental')),
 run_key TEXT NOT NULL, slice_key TEXT NOT NULL CHECK(slice_key IN ('recent','older','live')),
 frozen_start TEXT, frozen_cutoff TEXT, page_token TEXT, history_cursor TEXT, last_discovery_at INTEGER,
 stage TEXT NOT NULL DEFAULT 'queued', discovery_version INTEGER NOT NULL DEFAULT 0 CHECK(discovery_version>=0 AND discovery_version<=9007199254740991), query_mode TEXT NOT NULL DEFAULT 'filtered' CHECK(query_mode IN ('filtered','broad')), pending_ids TEXT, pending_deleted_ids TEXT, pending_next_token TEXT, pending_history_id TEXT, enumerated_count INTEGER NOT NULL DEFAULT 0 CHECK(enumerated_count>=0), matched_count INTEGER NOT NULL DEFAULT 0 CHECK(matched_count>=0), unknown_count INTEGER NOT NULL DEFAULT 0 CHECK(unknown_count>=0), retry_at INTEGER, coverage_code TEXT NOT NULL DEFAULT 'filtered_query' CHECK(coverage_code IN ('filtered_query','broad_metadata','candidate_unknown','recovering_history')), recovery_anchor TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0 AND consecutive_failures<=5), history_reset_count INTEGER NOT NULL DEFAULT 0 CHECK(history_reset_count>=0), PRIMARY KEY(user_id,id), UNIQUE(user_id,id,connection_id),
 UNIQUE(user_id,connection_id,scope_key,sync_kind,run_key,slice_key),
 CHECK((sync_kind='incremental' AND import_run_id IS NULL AND run_key='live' AND slice_key='live') OR
 (sync_kind='backfill' AND import_run_id IS NOT NULL AND run_key=import_run_id AND slice_key IN ('recent','older') AND frozen_start IS NOT NULL AND frozen_cutoff IS NOT NULL)),
 FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,import_run_id,connection_id) REFERENCES import_runs(user_id,id,connection_id) ON DELETE CASCADE
);

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

CREATE TABLE "user" ("id" TEXT PRIMARY KEY NOT NULL,
"name" TEXT NOT NULL,
"email" TEXT NOT NULL UNIQUE,
"emailVerified" INTEGER NOT NULL,
"image" TEXT,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL);

CREATE TABLE "verification" ("id" TEXT PRIMARY KEY NOT NULL,
"identifier" TEXT NOT NULL,
"value" TEXT NOT NULL,
"expiresAt" INTEGER NOT NULL,
"createdAt" INTEGER NOT NULL,
"updatedAt" INTEGER NOT NULL);

CREATE UNIQUE INDEX account_provider_identity ON "account"(providerId, accountId);

CREATE INDEX accounts_user ON "account"(userId);

CREATE INDEX ai_events_tenant_cooldown ON usage_events(user_id,destination_id,model_id,cooldown_until DESC);

CREATE INDEX ai_events_tenant_state ON usage_events(user_id,state);

CREATE INDEX ai_extractions_document_completed ON ai_extractions(user_id,document_id,run_key) WHERE completed_at IS NOT NULL;

CREATE INDEX archive_objects_pending ON archive_objects(user_id,state,lease_expires_at,id);

CREATE INDEX connections_due ON connections(scheduling_state,next_sync_at,user_id,id);

CREATE INDEX connections_tenant_due ON connections(user_id,scheduling_state,next_sync_at,id);

CREATE INDEX consents_connection_background ON processing_consents(user_id,connection_id,accepted_at DESC,id) WHERE revoked_at IS NULL AND background_authorized=1;

CREATE INDEX correction_audit_entity ON correction_audit(user_id,entity_kind,entity_id,created_at,id);

CREATE INDEX discovery_jobs_source ON discovery_source_jobs(user_id,source_message_id);

CREATE INDEX discovery_sources_run ON discovery_run_sources(user_id,import_run_id,candidate_kind,source_message_id);

CREATE UNIQUE INDEX documents_pipeline_index ON documents(user_id,source_message_id,pipeline_index) WHERE pipeline_index IS NOT NULL;

CREATE INDEX documents_tenant_hash ON documents(user_id,content_hash);

CREATE INDEX entry_valuations_current ON entry_valuations(user_id,entry_id,profile_version,entry_version,reporting_currency,calculation_version,policy_hash);

CREATE INDEX fx_rates_public_lookup ON fx_rates(source,from_currency,to_currency,effective_date DESC);

CREATE INDEX jobs_dispatchable ON jobs(user_id,priority,dispatch_at,id) WHERE status IN ('ready','retry_wait');

CREATE INDEX jobs_due ON jobs(status,dispatch_at,user_id,id);

CREATE INDEX jobs_global_leases ON jobs(status,lease_expires_at,id);

CREATE INDEX jobs_pending_sync ON jobs(user_id,connection_id,connection_generation,id) WHERE type='sync' AND status IN ('ready','leased','retry_wait');

CREATE INDEX jobs_tenant_leases ON jobs(user_id,status,lease_expires_at,id);

CREATE INDEX jobs_tenant_ready ON jobs(user_id,status,priority,dispatch_at,id);

CREATE INDEX jobs_tenant_recovery ON jobs(user_id,id,status);

CREATE INDEX ledger_entries_observation ON ledger_entries(user_id,observation_id,id);

CREATE INDEX ledger_entries_purchase ON ledger_entries(user_id,purchase_id,id);

CREATE INDEX ledger_tenant_currency_id ON ledger_entries(user_id,currency,id);

CREATE INDEX ledger_tenant_date ON ledger_entries(user_id,event_date,id);

CREATE INDEX lifecycle_cleanup_pending ON lifecycle_deletions(scope,journal_ack,deleted_at,user_id);

CREATE INDEX manual_evidence_document ON manual_purchase_evidence(user_id,document_id,purchase_id);

CREATE UNIQUE INDEX oauth_states_owner_hash ON oauth_states(user_id,state_hash);

CREATE INDEX oauth_states_tenant_expiry ON oauth_states(user_id,expires_at,state_hash);

CREATE INDEX observations_invoice_reference ON observations(user_id,merchant_key,invoice_ref) WHERE invoice_ref IS NOT NULL;

CREATE INDEX observations_order_reference ON observations(user_id,merchant_key,order_ref) WHERE order_ref IS NOT NULL;

CREATE INDEX observations_tenant_review ON observations(user_id,review_state,id);

CREATE INDEX onboarding_run_interval ON import_runs(user_id,connection_id,onboarding_interval_key,started_at);

CREATE INDEX outlook_inventory_pending ON outlook_inventory_states(user_id,connection_id,generation,state,scope_key);

CREATE INDEX profiles_schedule_page ON profiles(status,user_id);

CREATE INDEX purchases_invoice_reference ON purchases(user_id,merchant_normalized,invoice_ref) WHERE invoice_ref IS NOT NULL;

CREATE INDEX purchases_order_reference ON purchases(user_id,merchant_normalized,order_ref) WHERE order_ref IS NOT NULL;

CREATE INDEX purchases_tenant_date ON purchases(user_id,document_date DESC,id);

CREATE INDEX purchases_tenant_merchant ON purchases(user_id,merchant_normalized,id);

CREATE INDEX review_items_tenant_purchase ON review_items(user_id,purchase_id,id);

CREATE INDEX review_items_tenant_status ON review_items(user_id,status,blocking_scope,id);

CREATE UNIQUE INDEX sessions_tenant_identity ON "session"(userId,id);

CREATE INDEX sessions_user ON "session"(userId);

CREATE INDEX usage_global_blocked ON usage_buckets(scope,blocked);

-- Required global dispatcher state from historical 0006. Fresh initialization
-- must retain its data defaults as well as tables, constraints and indexes.
INSERT INTO scheduler_cursors(kind) VALUES('dispatch'),('schedule'),('recovery');
