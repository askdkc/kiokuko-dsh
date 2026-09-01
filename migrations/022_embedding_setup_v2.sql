-- Persist local embedding setup state while retaining the immutable v1
-- semantic projections. This migration performs no model or network I/O.

CREATE TABLE embedding_profiles_v2 (
    profile_id TEXT PRIMARY KEY
        CHECK (length(profile_id) = 64 AND profile_id NOT GLOB '*[^0-9a-f]*'),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2)),
    provider_kind TEXT NOT NULL
        CHECK (provider_kind IN ('openai-compatible', 'local-transformers')),
    endpoint_fingerprint TEXT
        CHECK (endpoint_fingerprint IS NULL OR (length(endpoint_fingerprint) = 64 AND endpoint_fingerprint NOT GLOB '*[^0-9a-f]*')),
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
    distance_ceiling REAL NOT NULL CHECK (distance_ceiling > 0.0 AND distance_ceiling < 2.0),
    document_template_version INTEGER NOT NULL CHECK (document_template_version > 0),
    query_template_version INTEGER NOT NULL CHECK (query_template_version > 0),
    preset_id TEXT,
    source_model TEXT,
    artifact_repository TEXT,
    model_revision TEXT,
    artifact_manifest_hash TEXT
        CHECK (artifact_manifest_hash IS NULL OR (length(artifact_manifest_hash) = 64 AND artifact_manifest_hash NOT GLOB '*[^0-9a-f]*')),
    inference_engine TEXT,
    inference_engine_version TEXT,
    dtype TEXT,
    pooling TEXT,
    normalize INTEGER CHECK (normalize IS NULL OR normalize IN (0, 1)),
    maximum_tokens INTEGER CHECK (maximum_tokens IS NULL OR maximum_tokens > 0),
    input_contract TEXT,
    query_prefix TEXT,
    document_prefix TEXT,
    created_at TEXT NOT NULL,
    CHECK (
        (schema_version = 1 AND provider_kind = 'openai-compatible'
            AND endpoint_fingerprint IS NOT NULL
            AND preset_id IS NULL AND source_model IS NULL AND artifact_repository IS NULL
            AND model_revision IS NULL AND artifact_manifest_hash IS NULL
            AND inference_engine IS NULL AND inference_engine_version IS NULL
            AND dtype IS NULL AND pooling IS NULL AND normalize IS NULL
            AND maximum_tokens IS NULL AND input_contract IS NULL
            AND query_prefix IS NULL AND document_prefix IS NULL)
        OR
        (schema_version = 2 AND provider_kind = 'local-transformers'
            AND endpoint_fingerprint IS NULL
            AND preset_id IS NOT NULL AND source_model IS NOT NULL
            AND artifact_repository IS NOT NULL AND model_revision IS NOT NULL
            AND artifact_manifest_hash IS NOT NULL AND inference_engine IS NOT NULL
            AND inference_engine_version IS NOT NULL AND dtype IS NOT NULL
            AND pooling IS NOT NULL AND normalize IS NOT NULL
            AND maximum_tokens IS NOT NULL AND input_contract IS NOT NULL
            AND query_prefix IS NOT NULL AND document_prefix IS NOT NULL)
    )
);

INSERT INTO embedding_profiles_v2 (
    profile_id, schema_version, provider_kind, endpoint_fingerprint, model,
    dimensions, distance_metric, distance_ceiling, document_template_version,
    query_template_version, created_at
)
SELECT profile_id, 1, provider_kind, endpoint_fingerprint, model,
       dimensions, distance_metric, distance_ceiling, document_template_version,
       query_template_version, created_at
  FROM embedding_profiles;

CREATE TABLE embedding_runtime_v2 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_profile_id TEXT REFERENCES embedding_profiles_v2(profile_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    activated_at TEXT
);

INSERT INTO embedding_runtime_v2 (singleton, active_profile_id, generation, activated_at)
SELECT singleton, active_profile_id, generation, activated_at
  FROM embedding_runtime;

CREATE TABLE entry_embeddings_v2 (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v2(profile_id) ON DELETE CASCADE,
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

INSERT INTO entry_embeddings_v2 (
    entry_id, profile_id, revision, content_hash, document_hash, dimensions,
    embedding, vector_hash, created_at
)
SELECT entry_id, profile_id, revision, content_hash, document_hash, dimensions,
       embedding, vector_hash, created_at
  FROM entry_embeddings;

CREATE TABLE embedding_jobs_v2 (
    entry_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v2(profile_id) ON DELETE CASCADE,
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

INSERT INTO embedding_jobs_v2 (
    entry_id, profile_id, revision, content_hash, state, attempts,
    available_at, lease_id, lease_expires_at, error_code, created_at, updated_at
)
SELECT entry_id, profile_id, revision, content_hash, state, attempts,
       available_at, lease_id, lease_expires_at, error_code, created_at, updated_at
  FROM embedding_jobs;

CREATE TABLE query_embeddings_v2 (
    profile_id TEXT NOT NULL REFERENCES embedding_profiles_v2(profile_id) ON DELETE CASCADE,
    query_hash TEXT NOT NULL CHECK (length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'),
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 2 AND 8192),
    embedding BLOB NOT NULL,
    vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64 AND vector_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, query_hash),
    CHECK (length(embedding) = dimensions * 4)
);

INSERT INTO query_embeddings_v2 (
    profile_id, query_hash, dimensions, embedding, vector_hash, created_at, last_used_at
)
SELECT profile_id, query_hash, dimensions, embedding, vector_hash, created_at, last_used_at
  FROM query_embeddings;

DROP INDEX idx_query_embeddings_lru;
DROP TABLE query_embeddings;
DROP INDEX idx_embedding_jobs_claim;
DROP TABLE embedding_jobs;
DROP INDEX idx_entry_embeddings_profile_revision;
DROP TABLE entry_embeddings;
DROP TABLE embedding_runtime;
DROP TRIGGER embedding_profiles_immutable_update;
DROP TABLE embedding_profiles;

ALTER TABLE embedding_profiles_v2 RENAME TO embedding_profiles;
ALTER TABLE embedding_runtime_v2 RENAME TO embedding_runtime;
ALTER TABLE entry_embeddings_v2 RENAME TO entry_embeddings;
ALTER TABLE embedding_jobs_v2 RENAME TO embedding_jobs;
ALTER TABLE query_embeddings_v2 RENAME TO query_embeddings;

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

CREATE TABLE embedding_model_installations (
    installation_id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    artifact_manifest_hash TEXT NOT NULL CHECK (length(artifact_manifest_hash) = 64 AND artifact_manifest_hash NOT GLOB '*[^0-9a-f]*'),
    relative_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staging', 'verified', 'corrupt', 'missing')),
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    installed_at TEXT NOT NULL,
    verified_at TEXT,
    last_checked_at TEXT NOT NULL
);

CREATE TABLE embedding_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    mode TEXT NOT NULL CHECK (mode IN ('off', 'optional', 'required')),
    provider_kind TEXT CHECK (provider_kind IS NULL OR provider_kind IN ('local-transformers', 'openai-compatible', 'legacy-environment')),
    preset_id TEXT,
    model_installation_id TEXT REFERENCES embedding_model_installations(installation_id),
    vector_backend TEXT NOT NULL CHECK (vector_backend IN ('auto', 'javascript', 'sqlite-vec')),
    batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 64),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 120000),
    legacy_profile_id TEXT REFERENCES embedding_profiles(profile_id),
    setup_state TEXT NOT NULL CHECK (setup_state IN ('disabled', 'requires_setup', 'installing', 'ready', 'degraded')),
    updated_at TEXT NOT NULL
);

INSERT INTO embedding_settings (
    singleton, mode, provider_kind, preset_id, model_installation_id,
    vector_backend, batch_size, timeout_ms, legacy_profile_id, setup_state, updated_at
)
SELECT 1,
       'off',
       CASE WHEN r.active_profile_id IS NULL THEN NULL ELSE 'legacy-environment' END,
       NULL,
       NULL,
       'auto',
       16,
       30000,
       r.active_profile_id,
       CASE WHEN r.active_profile_id IS NULL THEN 'disabled' ELSE 'requires_setup' END,
       COALESCE(r.activated_at, '1970-01-01T00:00:00.000Z')
  FROM embedding_runtime AS r;

CREATE TABLE embedding_setup_runs (
    setup_id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('planned', 'downloading', 'verifying', 'probing', 'activating', 'embedding', 'completed', 'failed')),
    model_installation_id TEXT REFERENCES embedding_model_installations(installation_id),
    active_profile_id TEXT REFERENCES embedding_profiles(profile_id),
    initial_entry_count INTEGER NOT NULL CHECK (initial_entry_count >= 0),
    processed_entry_count INTEGER NOT NULL CHECK (processed_entry_count >= 0),
    failure_code TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
