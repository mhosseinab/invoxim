-- Atomic tenant report revision. Read as CAST(reporting_revision AS TEXT), never Number money.
-- Existing profiles/new profiles initialize to 1; profile.version retains preference semantics.
-- Report projection dependencies below are explicit UPDATE OF + null-safe value comparisons.
-- INSERT/DELETE invalidate membership; ownership UPDATE invalidates OLD and NEW tenants.
-- Missing profiles during account/profile cascades have no report and are safely ignored.
-- Operational cursors, parser/sync states, ciphertext, recovery timestamps are deliberately excluded.
-- A new report/export/filter field must extend this dependency list and its behavioral tests.
ALTER TABLE profiles ADD COLUMN reporting_revision INTEGER NOT NULL DEFAULT 1
 CHECK(typeof(reporting_revision)='integer' AND reporting_revision BETWEEN 1 AND 9007199254740991);

-- Monotonicity and overflow cannot be bypassed by an outer OR IGNORE conflict policy.
CREATE TRIGGER reporting_revision_monotonic BEFORE UPDATE OF reporting_revision ON profiles
WHEN NEW.reporting_revision < OLD.reporting_revision
BEGIN
 SELECT RAISE(ABORT,'REPORTING_REVISION_REGRESSION');
END;

-- ledger_entries: id, user_id, purchase_id, observation_id, kind, amount_minor, currency, event_date, date_basis, eligible, origin, version.
CREATE TRIGGER reporting_ledger_entries_insert AFTER INSERT ON ledger_entries
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_ledger_entries_delete AFTER DELETE ON ledger_entries
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_ledger_entries_update AFTER UPDATE OF id, user_id, purchase_id, observation_id, kind, amount_minor, currency, event_date, date_basis, eligible, origin, version ON ledger_entries
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.purchase_id IS NOT NEW.purchase_id
 OR OLD.observation_id IS NOT NEW.observation_id
 OR OLD.kind IS NOT NEW.kind
 OR OLD.amount_minor IS NOT NEW.amount_minor
 OR OLD.currency IS NOT NEW.currency
 OR OLD.event_date IS NOT NEW.event_date
 OR OLD.date_basis IS NOT NEW.date_basis
 OR OLD.eligible IS NOT NEW.eligible
 OR OLD.origin IS NOT NEW.origin
 OR OLD.version IS NOT NEW.version
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- entry_valuations: user_id, entry_id, reporting_currency, profile_version, entry_version, calculation_version, policy_hash, policy_source, max_prior_age_days, original_kind, original_minor, original_currency, original_event_date, status, signed_minor, basis, reason, rate_id, version.
CREATE TRIGGER reporting_entry_valuations_insert AFTER INSERT ON entry_valuations
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_entry_valuations_delete AFTER DELETE ON entry_valuations
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_entry_valuations_update AFTER UPDATE OF user_id, entry_id, reporting_currency, profile_version, entry_version, calculation_version, policy_hash, policy_source, max_prior_age_days, original_kind, original_minor, original_currency, original_event_date, status, signed_minor, basis, reason, rate_id, version ON entry_valuations
WHEN OLD.user_id IS NOT NEW.user_id
 OR OLD.entry_id IS NOT NEW.entry_id
 OR OLD.reporting_currency IS NOT NEW.reporting_currency
 OR OLD.profile_version IS NOT NEW.profile_version
 OR OLD.entry_version IS NOT NEW.entry_version
 OR OLD.calculation_version IS NOT NEW.calculation_version
 OR OLD.policy_hash IS NOT NEW.policy_hash
 OR OLD.policy_source IS NOT NEW.policy_source
 OR OLD.max_prior_age_days IS NOT NEW.max_prior_age_days
 OR OLD.original_kind IS NOT NEW.original_kind
 OR OLD.original_minor IS NOT NEW.original_minor
 OR OLD.original_currency IS NOT NEW.original_currency
 OR OLD.original_event_date IS NOT NEW.original_event_date
 OR OLD.status IS NOT NEW.status
 OR OLD.signed_minor IS NOT NEW.signed_minor
 OR OLD.basis IS NOT NEW.basis
 OR OLD.reason IS NOT NEW.reason
 OR OLD.rate_id IS NOT NEW.rate_id
 OR OLD.version IS NOT NEW.version
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- purchases: id, user_id, merchant_raw, invoice_ref, order_ref, document_date, total_minor, currency, category, payment_state, record_status, version, origin, lifecycle_delete_connection_id, lifecycle_recompute_connection_id.
CREATE TRIGGER reporting_purchases_insert AFTER INSERT ON purchases
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_purchases_delete AFTER DELETE ON purchases
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_purchases_update AFTER UPDATE OF id, user_id, merchant_raw, invoice_ref, order_ref, document_date, total_minor, currency, category, payment_state, record_status, version, origin, lifecycle_delete_connection_id, lifecycle_recompute_connection_id ON purchases
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.merchant_raw IS NOT NEW.merchant_raw
 OR OLD.invoice_ref IS NOT NEW.invoice_ref
 OR OLD.order_ref IS NOT NEW.order_ref
 OR OLD.document_date IS NOT NEW.document_date
 OR OLD.total_minor IS NOT NEW.total_minor
 OR OLD.currency IS NOT NEW.currency
 OR OLD.category IS NOT NEW.category
 OR OLD.payment_state IS NOT NEW.payment_state
 OR OLD.record_status IS NOT NEW.record_status
 OR OLD.version IS NOT NEW.version
 OR OLD.origin IS NOT NEW.origin
 OR OLD.lifecycle_delete_connection_id IS NOT NEW.lifecycle_delete_connection_id
 OR OLD.lifecycle_recompute_connection_id IS NOT NEW.lifecycle_recompute_connection_id
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- purchase_evidence: user_id, purchase_id, observation_id, relationship.
CREATE TRIGGER reporting_purchase_evidence_insert AFTER INSERT ON purchase_evidence
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_purchase_evidence_delete AFTER DELETE ON purchase_evidence
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_purchase_evidence_update AFTER UPDATE OF user_id, purchase_id, observation_id, relationship ON purchase_evidence
WHEN OLD.user_id IS NOT NEW.user_id
 OR OLD.purchase_id IS NOT NEW.purchase_id
 OR OLD.observation_id IS NOT NEW.observation_id
 OR OLD.relationship IS NOT NEW.relationship
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- manual_purchase_evidence: user_id, purchase_id, document_id.
CREATE TRIGGER reporting_manual_purchase_evidence_insert AFTER INSERT ON manual_purchase_evidence
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_manual_purchase_evidence_delete AFTER DELETE ON manual_purchase_evidence
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_manual_purchase_evidence_update AFTER UPDATE OF user_id, purchase_id, document_id ON manual_purchase_evidence
WHEN OLD.user_id IS NOT NEW.user_id
 OR OLD.purchase_id IS NOT NEW.purchase_id
 OR OLD.document_id IS NOT NEW.document_id
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- review_items: id, user_id, document_id, observation_id, purchase_id, reason, blocking_scope, status, created_at, version, missing_fields_json.
CREATE TRIGGER reporting_review_items_insert AFTER INSERT ON review_items
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_review_items_delete AFTER DELETE ON review_items
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_review_items_update AFTER UPDATE OF id, user_id, document_id, observation_id, purchase_id, reason, blocking_scope, status, created_at, version, missing_fields_json ON review_items
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.document_id IS NOT NEW.document_id
 OR OLD.observation_id IS NOT NEW.observation_id
 OR OLD.purchase_id IS NOT NEW.purchase_id
 OR OLD.reason IS NOT NEW.reason
 OR OLD.blocking_scope IS NOT NEW.blocking_scope
 OR OLD.status IS NOT NEW.status
 OR OLD.created_at IS NOT NEW.created_at
 OR OLD.version IS NOT NEW.version
 OR OLD.missing_fields_json IS NOT NEW.missing_fields_json
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- observations: id, user_id, document_id, evidence_code, review_state, normalized_fields, structured_fields.
CREATE TRIGGER reporting_observations_insert AFTER INSERT ON observations
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_observations_delete AFTER DELETE ON observations
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_observations_update AFTER UPDATE OF id, user_id, document_id, evidence_code, review_state, normalized_fields, structured_fields ON observations
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.document_id IS NOT NEW.document_id
 OR OLD.evidence_code IS NOT NEW.evidence_code
 OR OLD.review_state IS NOT NEW.review_state
 OR OLD.normalized_fields IS NOT NEW.normalized_fields
 OR OLD.structured_fields IS NOT NEW.structured_fields
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- documents: id, user_id, source_message_id, content_hash.
CREATE TRIGGER reporting_documents_insert AFTER INSERT ON documents
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_documents_delete AFTER DELETE ON documents
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_documents_update AFTER UPDATE OF id, user_id, source_message_id, content_hash ON documents
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.source_message_id IS NOT NEW.source_message_id
 OR OLD.content_hash IS NOT NEW.content_hash
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- source_messages: id, user_id, connection_id, provider_message_id, available.
CREATE TRIGGER reporting_source_messages_insert AFTER INSERT ON source_messages
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_source_messages_delete AFTER DELETE ON source_messages
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_source_messages_update AFTER UPDATE OF id, user_id, connection_id, provider_message_id, available ON source_messages
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.connection_id IS NOT NEW.connection_id
 OR OLD.provider_message_id IS NOT NEW.provider_message_id
 OR OLD.available IS NOT NEW.available
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- connections: id, user_id, provider, state.
CREATE TRIGGER reporting_connections_insert AFTER INSERT ON connections
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_connections_delete AFTER DELETE ON connections
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_connections_update AFTER UPDATE OF id, user_id, provider, state ON connections
WHEN OLD.id IS NOT NEW.id
 OR OLD.user_id IS NOT NEW.user_id
 OR OLD.provider IS NOT NEW.provider
 OR OLD.state IS NOT NEW.state
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- field_overrides: user_id, entity_kind, entity_id, field, original_value_json, value_json, revision.
CREATE TRIGGER reporting_field_overrides_insert AFTER INSERT ON field_overrides
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

CREATE TRIGGER reporting_field_overrides_delete AFTER DELETE ON field_overrides
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=OLD.user_id;
END;

CREATE TRIGGER reporting_field_overrides_update AFTER UPDATE OF user_id, entity_kind, entity_id, field, original_value_json, value_json, revision ON field_overrides
WHEN OLD.user_id IS NOT NEW.user_id
 OR OLD.entity_kind IS NOT NEW.entity_kind
 OR OLD.entity_id IS NOT NEW.entity_id
 OR OLD.field IS NOT NEW.field
 OR OLD.original_value_json IS NOT NEW.original_value_json
 OR OLD.value_json IS NOT NEW.value_json
 OR OLD.revision IS NOT NEW.revision
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id IN (OLD.user_id,NEW.user_id);
END;

-- Profile stamp inputs; revision-only updates do not recurse.
CREATE TRIGGER reporting_profiles_update AFTER UPDATE OF user_id, status, version, reporting_currency, timezone ON profiles
WHEN OLD.user_id IS NOT NEW.user_id
 OR OLD.status IS NOT NEW.status
 OR OLD.version IS NOT NEW.version
 OR OLD.reporting_currency IS NOT NEW.reporting_currency
 OR OLD.timezone IS NOT NEW.timezone
BEGIN
 UPDATE profiles SET reporting_revision=CASE WHEN reporting_revision=9007199254740991 THEN RAISE(ABORT,'REPORTING_REVISION_EXHAUSTED') ELSE reporting_revision+1 END WHERE user_id=NEW.user_id;
END;

-- Public quote snapshots are insert-only in ordinary code. Existing provenance is immutable.
CREATE TRIGGER reporting_fx_rates_immutable BEFORE UPDATE OF id, source, from_currency, to_currency, requested_date, effective_date, rate, retrieved_at, source_version ON fx_rates
WHEN OLD.id IS NOT NEW.id
 OR OLD.source IS NOT NEW.source
 OR OLD.from_currency IS NOT NEW.from_currency
 OR OLD.to_currency IS NOT NEW.to_currency
 OR OLD.requested_date IS NOT NEW.requested_date
 OR OLD.effective_date IS NOT NEW.effective_date
 OR OLD.rate IS NOT NEW.rate
 OR OLD.retrieved_at IS NOT NEW.retrieved_at
 OR OLD.source_version IS NOT NEW.source_version
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_FX_RATE');
END;
