-- Root inventory stores verified opaque IDs for the four default folder exclusions.
ALTER TABLE outlook_inventory_states ADD COLUMN excluded_folder_ids TEXT
  CHECK(excluded_folder_ids IS NULL OR
    (scope_key='root' AND json_valid(excluded_folder_ids) AND
     json_type(excluded_folder_ids)='array' AND
     json_array_length(excluded_folder_ids)=4 AND
     length(excluded_folder_ids)<=1100));
