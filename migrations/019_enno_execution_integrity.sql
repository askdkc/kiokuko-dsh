-- Enno continuation, execution ownership, crash recovery, and repository-bound
-- verifier evidence. Existing v0.2.x rows remain readable; legacy evidence has
-- NULL repository digests and is never treated as repository-state-bound.

ALTER TABLE enno_contracts
ADD COLUMN route_epoch INTEGER NOT NULL DEFAULT 0
CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0);

CREATE TABLE enno_resume_tokens (
    token_hash TEXT PRIMARY KEY CHECK (
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    repository_root TEXT NOT NULL,
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    client_kind TEXT NOT NULL CHECK (client_kind IN ('codex', 'claude', 'opencode')),
    client_session_id TEXT NOT NULL CHECK (length(client_session_id) BETWEEN 1 AND 256),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_enno_resume_tokens_run_epoch
ON enno_resume_tokens(run_id, route_epoch, expires_at);

CREATE TABLE enno_execution_leases (
    run_id TEXT PRIMARY KEY REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (typeof(contract_revision) = 'integer' AND contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (typeof(mutation_revision) = 'integer' AND mutation_revision >= 0),
    work_unit_id TEXT NOT NULL CHECK (length(work_unit_id) BETWEEN 1 AND 256),
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    owner_client_kind TEXT NOT NULL CHECK (owner_client_kind IN ('codex', 'claude', 'opencode')),
    owner_session_id TEXT NOT NULL CHECK (length(owner_session_id) BETWEEN 1 AND 256),
    lease_token_hash TEXT NOT NULL UNIQUE CHECK (
        length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id)
);

ALTER TABLE enno_operation_receipts RENAME TO enno_operation_receipts_v18;

CREATE TABLE enno_operation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN (
        'ideal_submit', 'advice_submit', 'plan_submit', 'answer', 'work_report',
        'finish', 'meditation_submit', 'verify_prepare'
    )),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed', 'abandoned')),
    response_json TEXT,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK (
        (state = 'started' AND response_json IS NULL AND finished_at IS NULL
          AND typeof(owner_nonce) = 'text' AND typeof(lease_expires_at) = 'text' AND typeof(heartbeat_at) = 'text')
        OR (state = 'completed' AND typeof(response_json) = 'text' AND finished_at IS NOT NULL)
        OR (state IN ('failed', 'abandoned') AND response_json IS NULL AND finished_at IS NOT NULL
          AND typeof(failure_code) = 'text')
    ),
    PRIMARY KEY (run_id, operation, idempotency_key)
);

INSERT INTO enno_operation_receipts (
    run_id, operation, idempotency_key, request_digest, state, response_json,
    owner_nonce, lease_expires_at, heartbeat_at, failure_code, created_at, finished_at
)
SELECT run_id, operation, idempotency_key, request_digest, state, response_json,
       CASE WHEN state = 'started' THEN 'legacy-owner-' || idempotency_key ELSE NULL END,
       CASE WHEN state = 'started' THEN created_at ELSE NULL END,
       CASE WHEN state = 'started' THEN created_at ELSE NULL END,
       NULL, created_at, finished_at
FROM enno_operation_receipts_v18;

DROP TABLE enno_operation_receipts_v18;

ALTER TABLE enno_verifier_runs RENAME TO enno_verifier_runs_v18;

CREATE TABLE enno_verifier_runs (
    verifier_run_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    work_unit_id TEXT,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (mutation_revision >= 0),
    verifier_id TEXT NOT NULL CHECK (length(verifier_id) BETWEEN 1 AND 256),
    verifier_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'passed', 'failed', 'timeout', 'spawn_failed', 'abandoned')),
    exit_code INTEGER,
    signal TEXT,
    duration_ms INTEGER,
    stdout_preview TEXT,
    stderr_preview TEXT,
    stdout_digest TEXT,
    stderr_digest TEXT,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    failure_code TEXT,
    repository_state_policy_version INTEGER,
    pre_repository_digest TEXT,
    post_repository_digest TEXT,
    verifier_spec_digest TEXT,
    changed_during_verification INTEGER CHECK (changed_during_verification IS NULL OR changed_during_verification IN (0, 1)),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id),
    CHECK (
        (status = 'started' AND finished_at IS NULL AND duration_ms IS NULL
          AND typeof(owner_nonce) = 'text' AND typeof(lease_expires_at) = 'text' AND typeof(heartbeat_at) = 'text')
        OR (status = 'abandoned' AND finished_at IS NOT NULL AND typeof(failure_code) = 'text')
        OR (status NOT IN ('started', 'abandoned') AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms >= 0)
    )
);

INSERT INTO enno_verifier_runs (
    verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
    verifier_id, verifier_json, status, exit_code, signal, duration_ms,
    stdout_preview, stderr_preview, stdout_digest, stderr_digest,
    owner_nonce, lease_expires_at, heartbeat_at, failure_code,
    repository_state_policy_version, pre_repository_digest, post_repository_digest,
    verifier_spec_digest, changed_during_verification, started_at, finished_at
)
SELECT verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
       verifier_id, verifier_json, status, exit_code, signal, duration_ms,
       stdout_preview, stderr_preview, stdout_digest, stderr_digest,
       CASE WHEN status = 'started' THEN 'legacy-owner-' || verifier_run_id ELSE NULL END,
       CASE WHEN status = 'started' THEN started_at ELSE NULL END,
       CASE WHEN status = 'started' THEN started_at ELSE NULL END,
       NULL, NULL, NULL, NULL, NULL, NULL, started_at, finished_at
FROM enno_verifier_runs_v18;

DROP TABLE enno_verifier_runs_v18;

CREATE INDEX idx_enno_verifier_runs_freshness
ON enno_verifier_runs(run_id, contract_revision, mutation_revision, status, finished_at DESC);

CREATE INDEX idx_enno_verifier_runs_lease
ON enno_verifier_runs(run_id, status, lease_expires_at);
