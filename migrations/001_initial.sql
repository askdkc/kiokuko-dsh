CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    remote_fingerprint TEXT,
    binding_schema_version INTEGER NOT NULL,
    agent_template_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

CREATE TABLE repository_locations (
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    canonical_root TEXT NOT NULL UNIQUE,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (repository_id, canonical_root)
);

CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('candidate', 'verified', 'superseded')
    ),
    trust_level TEXT NOT NULL DEFAULT 'user_asserted' CHECK (
        trust_level IN ('untrusted', 'user_asserted', 'source_verified', 'system_verified')
    ),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    current_revision INTEGER NOT NULL CHECK (current_revision > 0),
    superseded_by TEXT REFERENCES entries(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT,
    CHECK (status != 'superseded' OR superseded_by IS NOT NULL)
);

CREATE UNIQUE INDEX idx_entries_id_workspace
    ON entries(id, workspace);
CREATE INDEX idx_entries_workspace_status
    ON entries(workspace, status, updated_at DESC);

CREATE TABLE entry_revisions (
    entry_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (
        kind IN ('fact', 'decision', 'lesson', 'preference', 'reference')
    ),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT,
    scope_json TEXT NOT NULL DEFAULT '{}',
    provenance_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, revision),
    FOREIGN KEY (entry_id, workspace)
        REFERENCES entries(id, workspace)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_entry_revisions_workspace_hash
    ON entry_revisions(workspace, content_hash);
CREATE INDEX idx_entry_revisions_entry_created
    ON entry_revisions(entry_id, revision DESC);

CREATE TABLE entry_revision_tags (
    entry_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, revision, tag),
    FOREIGN KEY (entry_id, revision)
        REFERENCES entry_revisions(entry_id, revision)
        ON DELETE CASCADE
);

CREATE INDEX idx_entry_revision_tags_tag
    ON entry_revision_tags(tag, entry_id, revision);

CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END;

CREATE TRIGGER entry_revision_tags_immutable_update
BEFORE UPDATE ON entry_revision_tags
BEGIN
    SELECT RAISE(ABORT, 'entry_revision_tags are immutable');
END;

CREATE TABLE entry_links (
    from_entry_id TEXT NOT NULL REFERENCES entries(id),
    to_entry_id TEXT NOT NULL REFERENCES entries(id),
    relation TEXT NOT NULL CHECK (
        relation IN ('supports', 'contradicts', 'derived_from', 'related_to')
    ),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (from_entry_id, to_entry_id, relation)
);

CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entries(id),
    workspace TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (
        operation IN ('record', 'promote', 'supersede', 'link', 'import', 'purge')
    ),
    actor TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
