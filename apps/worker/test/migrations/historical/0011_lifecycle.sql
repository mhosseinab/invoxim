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
CREATE INDEX lifecycle_cleanup_pending ON lifecycle_deletions(scope,journal_ack,deleted_at,user_id);
