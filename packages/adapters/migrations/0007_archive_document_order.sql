-- Stable metadata admission order for explicitly frozen archive backfills.
-- AUTOINCREMENT prevents deletion/reinsertion from reusing an approved cutoff.
-- Existing runs retain NULL cutoffs: their historical approval covered one window.
CREATE TABLE archive_document_order (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT
 CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991),
 user_id TEXT NOT NULL,
 document_id TEXT NOT NULL,
 UNIQUE(user_id,document_id),
 FOREIGN KEY(user_id,document_id) REFERENCES documents(user_id,id) ON DELETE CASCADE
);
CREATE INDEX archive_document_order_owner ON archive_document_order(user_id,sequence);
CREATE INDEX archive_dispatch_backfill_cleanup ON archive_dispatch(user_id,backfill_run_id,status,queue_id);

INSERT INTO archive_document_order(user_id,document_id)
 SELECT user_id,id FROM documents ORDER BY user_id,id;

CREATE TRIGGER archive_document_order_insert AFTER INSERT ON documents
BEGIN
 INSERT INTO archive_document_order(user_id,document_id) VALUES(NEW.user_id,NEW.id);
END;

ALTER TABLE archive_backfill_runs ADD COLUMN snapshot_sequence INTEGER
 CHECK(snapshot_sequence IS NULL OR (typeof(snapshot_sequence)='integer' AND snapshot_sequence BETWEEN 0 AND 9007199254740991));
ALTER TABLE archive_backfill_runs ADD COLUMN enumerated_through_sequence INTEGER NOT NULL DEFAULT 0
 CHECK(typeof(enumerated_through_sequence)='integer' AND enumerated_through_sequence BETWEEN 0 AND 9007199254740991
 AND (snapshot_sequence IS NULL OR enumerated_through_sequence<=snapshot_sequence));
ALTER TABLE archive_backfill_runs ADD COLUMN processed_count INTEGER NOT NULL DEFAULT 0
 CHECK(typeof(processed_count)='integer' AND processed_count BETWEEN 0 AND 9007199254740991);
