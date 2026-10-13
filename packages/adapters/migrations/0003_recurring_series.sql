-- Tenant-owned recurrence decisions and references. These never create ledger entries.
CREATE TABLE recurring_series (
 user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
 id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 256),
 identity_kind TEXT NOT NULL CHECK(identity_kind IN ('user-confirmed','service-reference')),
 identity_key TEXT NOT NULL CHECK(length(identity_key) BETWEEN 1 AND 200),
 currency TEXT NOT NULL CHECK(length(currency)=3 AND currency NOT GLOB '*[^A-Z]*'),
 cadence TEXT NOT NULL CHECK(cadence IN ('weekly','monthly','annual')),
 anchor_date TEXT NOT NULL CHECK(length(anchor_date)=10 AND anchor_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 state TEXT NOT NULL DEFAULT 'suggestion' CHECK(state IN ('suggestion','confirmed','dismissed','paused','canceled')),
 pricing_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(pricing_kind IN ('unknown','fixed','usage-variable')),
 selected_entry_count INTEGER NOT NULL CHECK(typeof(selected_entry_count)='integer' AND selected_entry_count BETWEEN 1 AND 20),
 version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483646),
 mutation_id TEXT NOT NULL CHECK(length(mutation_id)=36),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(user_id,id)
);
CREATE TABLE recurring_entries (
 user_id TEXT NOT NULL,
 series_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 selected_entry_version INTEGER NOT NULL CHECK(typeof(selected_entry_version)='integer' AND selected_entry_version BETWEEN 1 AND 2147483646),
 selected_purchase_version INTEGER NOT NULL CHECK(typeof(selected_purchase_version)='integer' AND selected_purchase_version BETWEEN 1 AND 2147483646),
 PRIMARY KEY(user_id,series_id,entry_id),
 FOREIGN KEY(user_id,series_id) REFERENCES recurring_series(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,entry_id) REFERENCES ledger_entries(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_recurring_entries_ledger ON recurring_entries(user_id,entry_id);
