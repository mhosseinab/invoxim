ALTER TABLE purchases ADD COLUMN lifecycle_delete_connection_id TEXT;
ALTER TABLE purchases ADD COLUMN lifecycle_recompute_connection_id TEXT;
ALTER TABLE purchases ADD COLUMN origin TEXT NOT NULL DEFAULT 'source' CHECK(origin IN ('source','user-supplied'));
ALTER TABLE review_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646);
CREATE TABLE review_items_next (
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
INSERT INTO review_items_next(id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at,missing_fields_json,version) SELECT id,user_id,document_id,observation_id,purchase_id,reason,blocking_scope,status,created_at,missing_fields_json,version FROM review_items;
DROP TABLE review_items;
ALTER TABLE review_items_next RENAME TO review_items;
CREATE INDEX review_items_tenant_status ON review_items(user_id,status,blocking_scope,id);
CREATE INDEX review_items_tenant_purchase ON review_items(user_id,purchase_id,id);
CREATE TABLE ledger_entries_next (
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
INSERT INTO ledger_entries_next(id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version) SELECT id,user_id,purchase_id,observation_id,business_event_key,kind,amount_minor,currency,event_date,date_basis,eligible,version FROM ledger_entries;
DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_next RENAME TO ledger_entries;
CREATE INDEX ledger_tenant_date ON ledger_entries(user_id,event_date,id);
CREATE INDEX ledger_tenant_currency_id ON ledger_entries(user_id,currency,id);
CREATE INDEX ledger_entries_purchase ON ledger_entries(user_id,purchase_id,id);
CREATE INDEX ledger_entries_observation ON ledger_entries(user_id,observation_id,id);
CREATE TABLE field_overrides (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,entity_kind TEXT NOT NULL CHECK(entity_kind IN ('purchase','entry')),entity_id TEXT NOT NULL,field TEXT NOT NULL,
 original_value_json TEXT NOT NULL CHECK(json_valid(original_value_json) AND length(original_value_json)<=1000),value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(value_json)<=1000),revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(user_id,entity_kind,entity_id,field)
);
CREATE TABLE correction_commands (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,route TEXT NOT NULL,key TEXT NOT NULL,body_hash TEXT NOT NULL,executor TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=65536),created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,route,key)
);
CREATE TABLE correction_audit (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,field TEXT,
 before_json TEXT NOT NULL CHECK(json_valid(before_json) AND length(before_json)<=1000),after_json TEXT NOT NULL CHECK(json_valid(after_json) AND length(after_json)<=1000),created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,id)
);
CREATE INDEX correction_audit_entity ON correction_audit(user_id,entity_kind,entity_id,created_at,id);
CREATE TABLE manual_purchase_evidence (
 user_id TEXT NOT NULL,purchase_id TEXT NOT NULL,document_id TEXT NOT NULL,
 PRIMARY KEY(user_id,purchase_id,document_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id)
);
CREATE INDEX manual_evidence_document ON manual_purchase_evidence(user_id,document_id,purchase_id);
CREATE TABLE ledger_match_decisions (
 user_id TEXT NOT NULL,content_hash TEXT NOT NULL,segment_index INTEGER NOT NULL CHECK(segment_index BETWEEN 0 AND 9),purchase_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('same-purchase','different-purchase')),
 PRIMARY KEY(user_id,content_hash,segment_index,purchase_id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);
CREATE TABLE purchase_merges (
 id TEXT NOT NULL,user_id TEXT NOT NULL,target_id TEXT NOT NULL,source_id TEXT NOT NULL,target_version INTEGER NOT NULL,source_version INTEGER NOT NULL,
 moved_json TEXT NOT NULL CHECK(json_valid(moved_json) AND length(moved_json)<=2097152),active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,target_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,source_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);
-- New purpose-specific deletion leaves change stage numbering. Restart quiesced cleanup safely.
UPDATE purchases SET payment_state='unknown',lifecycle_recompute_connection_id=CASE WHEN (SELECT COUNT(*) FROM lifecycle_deletions ld WHERE ld.user_id=purchases.user_id AND ld.scope='connection')=1 THEN (SELECT ld.target_id FROM lifecycle_deletions ld WHERE ld.user_id=purchases.user_id AND ld.scope='connection' LIMIT 1) ELSE NULL END WHERE EXISTS(SELECT 1 FROM review_items r WHERE r.user_id=purchases.user_id AND r.purchase_id=purchases.id AND r.id='source-deletion:'||purchases.id AND r.reason='incomplete-financial-facts' AND r.observation_id IS NULL AND r.status='open');
UPDATE review_items SET reason='payment-allocation-review',document_id=NULL WHERE reason='incomplete-financial-facts' AND observation_id IS NULL AND status='open' AND purchase_id IS NOT NULL AND id='source-deletion:'||purchase_id;
UPDATE lifecycle_deletions SET stage=0;
