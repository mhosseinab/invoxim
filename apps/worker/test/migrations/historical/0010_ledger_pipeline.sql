ALTER TABLE documents ADD COLUMN pipeline_index INTEGER CHECK(pipeline_index IS NULL OR (typeof(pipeline_index)='integer' AND pipeline_index BETWEEN 0 AND 63));
ALTER TABLE documents ADD COLUMN parser_version TEXT CHECK(parser_version IS NULL OR length(parser_version) BETWEEN 1 AND 120);
ALTER TABLE documents ADD COLUMN parse_code TEXT CHECK(parse_code IS NULL OR length(parse_code) BETWEEN 1 AND 80);
CREATE UNIQUE INDEX documents_pipeline_index ON documents(user_id,source_message_id,pipeline_index) WHERE pipeline_index IS NOT NULL;
ALTER TABLE discovery_source_jobs ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'parse' CHECK(pipeline_stage IN ('parse','infer','reconcile'));
ALTER TABLE discovery_source_jobs ADD COLUMN document_index INTEGER NOT NULL DEFAULT 0 CHECK(typeof(document_index)='integer' AND document_index BETWEEN 0 AND 63);
ALTER TABLE discovery_source_jobs ADD COLUMN extraction_fingerprint TEXT CHECK(extraction_fingerprint IS NULL OR (length(extraction_fingerprint)=64 AND extraction_fingerprint NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE observations ADD COLUMN structured_fields TEXT CHECK(structured_fields IS NULL OR (length(structured_fields)<=12000 AND json_valid(structured_fields) AND COALESCE(json_type(structured_fields,'$.schemaVersion')='integer' AND json_extract(structured_fields,'$.schemaVersion')=1,0) AND json_remove(structured_fields,'$.schemaVersion','$.documentType','$.record')='{}' AND json_type(structured_fields,'$.record')='object' AND json_remove(json_extract(structured_fields,'$.record'),'$.merchant','$.documentDate','$.eventDate','$.currency','$.total','$.tax','$.invoiceNumber','$.orderReference','$.paymentReference','$.refundReference','$.category','$.paymentEvidence','$.refundEvidence','$.paymentMethodHint','$.recurringCadence','$.paymentAmount','$.refundAmount','$.storeCreditAmount','$.provenance')='{}'));
CREATE TABLE review_items (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 document_id TEXT NOT NULL,observation_id TEXT,purchase_id TEXT,
 reason TEXT NOT NULL CHECK(reason IN ('extraction-review','incomplete-financial-facts','unknown-payment','ambiguous-event','event-conflict','invoice-conflict','purchase-conflict','possible-duplicate','unmatched-refund','refund-exceeds-payment','refund-currency-mismatch','credit-note-completion','mixed-tender','document-review')),
 blocking_scope TEXT NOT NULL CHECK(blocking_scope IN ('financial','operational')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,observation_id) REFERENCES observations(user_id,id),
 FOREIGN KEY(user_id,purchase_id) REFERENCES purchases(user_id,id) ON DELETE CASCADE
);
CREATE INDEX review_items_tenant_status ON review_items(user_id,status,blocking_scope,id);
CREATE INDEX purchases_invoice_reference ON purchases(user_id,merchant_normalized,invoice_ref) WHERE invoice_ref IS NOT NULL;
CREATE INDEX purchases_order_reference ON purchases(user_id,merchant_normalized,order_ref) WHERE order_ref IS NOT NULL;
CREATE INDEX ledger_entries_purchase ON ledger_entries(user_id,purchase_id,id);
CREATE INDEX ai_extractions_document_completed ON ai_extractions(user_id,document_id,run_key) WHERE completed_at IS NOT NULL;
ALTER TABLE observations ADD COLUMN merchant_key TEXT;
ALTER TABLE observations ADD COLUMN invoice_ref TEXT;
ALTER TABLE observations ADD COLUMN order_ref TEXT;
CREATE INDEX observations_invoice_reference ON observations(user_id,merchant_key,invoice_ref) WHERE invoice_ref IS NOT NULL;
CREATE INDEX observations_order_reference ON observations(user_id,merchant_key,order_ref) WHERE order_ref IS NOT NULL;
CREATE INDEX ledger_entries_observation ON ledger_entries(user_id,observation_id,id);
