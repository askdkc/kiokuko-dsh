CREATE TABLE external_skill_generation_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN 0 AND 9007199254740991)
);

INSERT INTO external_skill_generation_clock (singleton, value) VALUES (1, 0);

CREATE TABLE external_skill_generation_tokens (
    generation INTEGER PRIMARY KEY AUTOINCREMENT
        CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE external_skills (
    skill_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL REFERENCES external_skill_generation_tokens(generation)
        CHECK (typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    install_url TEXT,
    official_status TEXT NOT NULL CHECK (official_status IN ('curated', 'catalog-verified', 'owner-verified', 'registry-only', 'unknown')),
    duplicate INTEGER NOT NULL DEFAULT 0 CHECK (duplicate IN (0, 1)),
    installs INTEGER NOT NULL DEFAULT 0 CHECK (installs >= 0),
    state TEXT NOT NULL CHECK (state IN ('discovered', 'imported', 'blocked', 'stale', 'disabled')),
    source_workspace TEXT NOT NULL,
    source_commit TEXT,
    snapshot_hash TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_checked_at TEXT NOT NULL,
    disabled_at TEXT,
    UNIQUE(generation),
    UNIQUE(source_type, source_locator, slug)
);

CREATE INDEX idx_external_skills_state_checked ON external_skills(state, last_checked_at DESC);
CREATE INDEX idx_external_skills_source ON external_skills(source_locator, slug);

CREATE TABLE external_skill_entries (
    skill_id TEXT NOT NULL REFERENCES external_skills(skill_id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    entry_id TEXT NOT NULL REFERENCES entries(id),
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    content_hash TEXT NOT NULL,
    primary_document INTEGER NOT NULL DEFAULT 0 CHECK (primary_document IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    imported_at TEXT NOT NULL,
    PRIMARY KEY(skill_id, source_path, chunk_index),
    FOREIGN KEY(entry_id, entry_revision) REFERENCES entry_revisions(entry_id, revision)
);

CREATE INDEX idx_external_skill_entries_entry ON external_skill_entries(entry_id, entry_revision);

CREATE TABLE skill_discovery_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    query_text TEXT NOT NULL,
    owner TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('official', 'community')),
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'empty', 'rate_limited', 'unavailable')),
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_skill_discovery_cache_expiry ON skill_discovery_cache(expires_at);

CREATE TABLE skill_source_failure_cache (
    cache_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('source_rate_limited', 'source_unavailable')),
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_skill_source_failure_cache_expiry ON skill_source_failure_cache(expires_at);

CREATE TABLE skill_audit_failure_cache (
    cache_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type = 'github'),
    source_locator TEXT NOT NULL,
    slug TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('registry_rate_limited', 'registry_unavailable')),
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_skill_audit_failure_cache_expiry ON skill_audit_failure_cache(expires_at);

CREATE TABLE agent_task_skill_discovery_attempts (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    request_digest TEXT NOT NULL CHECK (
        typeof(request_digest) = 'text'
        AND length(request_digest) = 64
        AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
    summary_json TEXT,
    failure_json TEXT,
    started_at TEXT NOT NULL CHECK (typeof(started_at) = 'text' AND length(started_at) > 0),
    finished_at TEXT,
    CHECK (
        finished_at IS NULL
        OR (typeof(finished_at) = 'text' AND length(finished_at) > 0 AND finished_at >= started_at)
    ),
    CHECK (
        (state = 'started' AND summary_json IS NULL AND failure_json IS NULL AND finished_at IS NULL)
        OR (state = 'completed' AND typeof(summary_json) = 'text' AND failure_json IS NULL AND finished_at IS NOT NULL)
        OR (state = 'failed' AND summary_json IS NULL AND typeof(failure_json) = 'text' AND finished_at IS NOT NULL)
    )
);

-- The application migration operation rewrites every revision preimage and
-- hash to the single locale-independent canonical representation before it
-- inserts this singleton. Leaving the row absent is never a supported state.
CREATE TABLE entry_revision_hash_format (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    algorithm TEXT NOT NULL CHECK (algorithm = 'canonical-json-utf16-tags-v1')
);
