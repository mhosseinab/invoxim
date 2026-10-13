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
CREATE INDEX outlook_inventory_pending ON outlook_inventory_states(user_id,connection_id,generation,state,scope_key);
