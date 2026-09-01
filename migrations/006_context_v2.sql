-- Versioned context metadata. Existing v1 rows retain their original meaning
-- through defaults; new deliveries may identify global-origin entries.
ALTER TABLE context_deliveries ADD COLUMN score_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (score_schema_version >= 1);
ALTER TABLE context_delivery_entries ADD COLUMN origin_scope TEXT NOT NULL DEFAULT 'project' CHECK (origin_scope IN ('project', 'global'));
