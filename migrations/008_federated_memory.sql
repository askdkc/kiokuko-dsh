-- Federated retrieval metadata. Existing structured scopes remain valid and
-- legacy project entries stay project-only unless explicit applicability is
-- present; no entry rows are rewritten by this migration.
CREATE TABLE repository_fingerprints (
    repository_id TEXT PRIMARY KEY
        REFERENCES repositories(repository_id)
        ON DELETE CASCADE,
    fingerprint_json TEXT NOT NULL,
    manifest_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entry_search_signals_type_value_entry
    ON entry_search_signals(signal_type, normalized_value, entry_id);

CREATE INDEX IF NOT EXISTS idx_entries_workspace_status
    ON entries(workspace, status);

-- Version 2 only allowed project/global delivery origins. Rebuild the small
-- projection table so context deliveries can retain ecosystem provenance.
CREATE TABLE context_delivery_entries_federated (
    delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    rank INTEGER NOT NULL CHECK (rank > 0),
    score_components_json TEXT NOT NULL,
    selection_reason_json TEXT NOT NULL,
    origin_scope TEXT NOT NULL DEFAULT 'project' CHECK (origin_scope IN ('project', 'ecosystem', 'global')),
    PRIMARY KEY (delivery_id, entry_id),
    FOREIGN KEY (entry_id, entry_revision)
        REFERENCES entry_revisions(entry_id, revision)
);

INSERT INTO context_delivery_entries_federated (
    delivery_id, entry_id, entry_revision, rank,
    score_components_json, selection_reason_json, origin_scope
)
SELECT delivery_id, entry_id, entry_revision, rank,
       score_components_json, selection_reason_json, origin_scope
  FROM context_delivery_entries;

DROP TABLE context_delivery_entries;
ALTER TABLE context_delivery_entries_federated RENAME TO context_delivery_entries;

CREATE INDEX idx_context_delivery_entries_entry
    ON context_delivery_entries(entry_id, entry_revision);
