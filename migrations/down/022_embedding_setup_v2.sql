-- Manual rollback for migration 022. Stop every Kiokuko process and make a
-- full SQLite backup before running this script. Local v2 profiles are not
-- silently converted to the v1 representation.

BEGIN IMMEDIATE;

CREATE TEMP TRIGGER embedding_setup_v2_rollback_guard
BEFORE DELETE ON schema_migrations
WHEN EXISTS (SELECT 1 FROM embedding_profiles WHERE schema_version = 2)
BEGIN
    SELECT RAISE(ABORT, 'migration 022 rollback requires removing local v2 profiles explicitly');
END;

CREATE TABLE embedding_profiles_v1 (
    profile_id TEXT PRIMARY KEY CHECK (length(profile_id) = 64 AND profile_id NOT GLOB '*[^0-9a-f]*'),
    provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai-compatible')),
    endpoint_fingerprint TEXT NOT NULL CHECK (length(endpoint_fingerprint) = 64 AND endpoint_fingerprint NOT GLOB '*[^0-9a-f]*'),
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
    distance_ceiling REAL NOT NULL CHECK (distance_ceiling > 0.0 AND distance_ceiling < 2.0),
    document_template_version INTEGER NOT NULL CHECK (document_template_version > 0),
    query_template_version INTEGER NOT NULL CHECK (query_template_version > 0),
    created_at TEXT NOT NULL
);
INSERT INTO embedding_profiles_v1 (
    profile_id, provider_kind, endpoint_fingerprint, model, dimensions,
    distance_metric, distance_ceiling, document_template_version,
    query_template_version, created_at
)
SELECT profile_id, provider_kind, endpoint_fingerprint, model, dimensions,
       distance_metric, distance_ceiling, document_template_version,
       query_template_version, created_at
  FROM embedding_profiles;

CREATE TABLE embedding_runtime_v1 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_profile_id TEXT REFERENCES embedding_profiles_v1(profile_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    activated_at TEXT
);
INSERT INTO embedding_runtime_v1 (singleton, active_profile_id, generation, activated_at)
SELECT singleton, active_profile_id, generation, activated_at FROM embedding_runtime;

CREATE TABLE entry_embeddings_v1 (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v1(profile_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL CHECK (length(document_hash) = 64 AND document_hash NOT GLOB '*[^0-9a-f]*'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    embedding BLOB NOT NULL,
    vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64 AND vector_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, profile_id),
    FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE,
    CHECK (length(embedding) = dimensions * 4)
);
INSERT INTO entry_embeddings_v1 SELECT * FROM entry_embeddings;

CREATE TABLE embedding_jobs_v1 (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v1(profile_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'failed', 'blocked')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    lease_id TEXT,
    lease_expires_at TEXT,
    error_code TEXT CHECK (error_code IS NULL OR error_code IN (
        'timeout', 'rate_limited', 'provider_unavailable', 'invalid_response',
        'dimension_mismatch', 'secret_blocked', 'profile_changed', 'entry_changed'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, profile_id),
    FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE,
    CHECK (
        (state = 'leased' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_id IS NULL AND lease_expires_at IS NULL)
    )
);
INSERT INTO embedding_jobs_v1 SELECT * FROM embedding_jobs;

CREATE TABLE query_embeddings_v1 (
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v1(profile_id) ON DELETE CASCADE,
    query_hash TEXT NOT NULL CHECK (length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    embedding BLOB NOT NULL,
    vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64 AND vector_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, query_hash),
    CHECK (length(embedding) = dimensions * 4)
);
INSERT INTO query_embeddings_v1 SELECT * FROM query_embeddings;

DELETE FROM schema_migrations WHERE version = 22 AND name = '022_embedding_setup_v2.sql';
DROP TRIGGER embedding_setup_v2_rollback_guard;

DROP TABLE embedding_setup_runs;
DROP TABLE embedding_settings;
DROP TABLE embedding_model_installations;
DROP INDEX idx_query_embeddings_lru;
DROP TABLE query_embeddings;
DROP INDEX idx_embedding_jobs_claim;
DROP TABLE embedding_jobs;
DROP INDEX idx_entry_embeddings_profile_revision;
DROP TABLE entry_embeddings;
DROP TABLE embedding_runtime;
DROP TRIGGER embedding_profiles_immutable_update;
DROP TABLE embedding_profiles;

ALTER TABLE embedding_profiles_v1 RENAME TO embedding_profiles;
ALTER TABLE embedding_runtime_v1 RENAME TO embedding_runtime;
ALTER TABLE entry_embeddings_v1 RENAME TO entry_embeddings;
ALTER TABLE embedding_jobs_v1 RENAME TO embedding_jobs;
ALTER TABLE query_embeddings_v1 RENAME TO query_embeddings;

CREATE TRIGGER embedding_profiles_immutable_update
BEFORE UPDATE ON embedding_profiles
BEGIN
    SELECT RAISE(ABORT, 'embedding_profiles are immutable');
END;
CREATE INDEX idx_entry_embeddings_profile_revision
    ON entry_embeddings(profile_id, entry_id, revision);
CREATE INDEX idx_embedding_jobs_claim
    ON embedding_jobs(profile_id, state, available_at, entry_id);
CREATE INDEX idx_query_embeddings_lru
    ON query_embeddings(profile_id, last_used_at, query_hash);

COMMIT;
