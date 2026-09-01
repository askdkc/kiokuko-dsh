-- Add the DeepSeek Harness route without changing the meaning of existing
-- client bindings. SQLite cannot alter a CHECK constraint in place while
-- foreign keys are enabled, so rebuild the Enno graph atomically from
-- constraint-free snapshots and restore every row, index, and trigger.

CREATE TABLE __kiokuko_023_enno_advisory_contributions AS
SELECT * FROM enno_advisory_contributions;
CREATE TABLE __kiokuko_023_enno_advisory_rounds AS
SELECT * FROM enno_advisory_rounds;
CREATE TABLE __kiokuko_023_enno_client_continuations AS
SELECT * FROM enno_client_continuations;
CREATE TABLE __kiokuko_023_enno_execution_leases AS
SELECT * FROM enno_execution_leases;
CREATE TABLE __kiokuko_023_enno_operation_receipts AS
SELECT * FROM enno_operation_receipts;
CREATE TABLE __kiokuko_023_enno_resume_tokens AS
SELECT * FROM enno_resume_tokens;
CREATE TABLE __kiokuko_023_enno_verifier_runs AS
SELECT * FROM enno_verifier_runs;
CREATE TABLE __kiokuko_023_enno_work_units AS
SELECT * FROM enno_work_units;
CREATE TABLE __kiokuko_023_enno_contracts AS
SELECT * FROM enno_contracts;

DROP TABLE enno_advisory_contributions;
DROP TABLE enno_execution_leases;
DROP TABLE enno_verifier_runs;
DROP TABLE enno_advisory_rounds;
DROP TABLE enno_operation_receipts;
DROP TABLE enno_resume_tokens;
DROP TABLE enno_client_continuations;
DROP TABLE enno_work_units;
DROP TABLE enno_contracts;

CREATE TABLE enno_contracts (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    orchestration_session_id TEXT NOT NULL CHECK (length(orchestration_session_id) BETWEEN 1 AND 256),
    client_kind TEXT CHECK (client_kind IS NULL OR client_kind IN ('codex', 'claude', 'opencode', 'dsh')),
    client_version TEXT CHECK (client_version IS NULL OR length(client_version) BETWEEN 1 AND 100),
    client_session_id TEXT CHECK (client_session_id IS NULL OR length(client_session_id) BETWEEN 1 AND 256),
    repository_root TEXT NOT NULL CHECK (length(repository_root) BETWEEN 1 AND 4096),
    task_type TEXT NOT NULL CHECK (task_type IN ('build', 'debug', 'review', 'devops')),
    status TEXT NOT NULL CHECK (status IN (
        'intake', 'zenki_planning', 'needs_confirmation', 'goki_executing',
        'enno_verifying', 'completed', 'blocked', 'cancelled'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    confirmation_state TEXT NOT NULL CHECK (confirmation_state IN (
        'not_required', 'pending', 'approved', 'revision_requested', 'cancelled'
    )),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
    mutation_revision INTEGER NOT NULL DEFAULT 0 CHECK (mutation_revision >= 0),
    contract_json TEXT NOT NULL,
    handoff_json TEXT NOT NULL,
    intake_discovery_json TEXT NOT NULL,
    plan_digest TEXT,
    blocker TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    phase TEXT CHECK (phase IS NULL OR phase IN ('oduno_ideal', 'oduno_meditation')),
    ideal_json TEXT,
    meditation_json TEXT,
    route_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    UNIQUE (run_id, workspace, orchestration_session_id),
    CHECK ((client_version IS NULL AND client_session_id IS NULL) OR client_kind IS NOT NULL)
);

CREATE TRIGGER enno_contract_identity_insert_guard
BEFORE INSERT ON enno_contracts
BEGIN
    SELECT RAISE(ABORT, 'enno contract run identity mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) <> NEW.workspace
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) <> NEW.orchestration_session_id;
END;

CREATE TRIGGER enno_contract_identity_update_guard
BEFORE UPDATE OF run_id, workspace, orchestration_session_id ON enno_contracts
BEGIN
    SELECT RAISE(ABORT, 'enno contract run identity mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) <> NEW.workspace
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT session_id FROM run_intakes WHERE run_id = NEW.run_id) <> NEW.orchestration_session_id;
END;

CREATE INDEX idx_enno_contracts_session_status
ON enno_contracts(client_kind, client_session_id, status, updated_at DESC);

CREATE TABLE enno_work_units (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    work_unit_id TEXT NOT NULL CHECK (length(work_unit_id) BETWEEN 1 AND 256),
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    order_index INTEGER NOT NULL CHECK (order_index >= 0),
    work_unit_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_revision, work_unit_id),
    UNIQUE (run_id, contract_revision, order_index)
);

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

CREATE INDEX idx_enno_verifier_runs_freshness
ON enno_verifier_runs(run_id, contract_revision, mutation_revision, status, finished_at DESC);
CREATE INDEX idx_enno_verifier_runs_lease
ON enno_verifier_runs(run_id, status, lease_expires_at);

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

CREATE TABLE enno_client_continuations (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    client_kind TEXT NOT NULL CHECK (client_kind IN ('codex', 'claude', 'opencode', 'dsh')),
    source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 256),
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (mutation_revision >= 0),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 20),
    directive_digest TEXT NOT NULL CHECK (
        length(directive_digest) = 64 AND directive_digest NOT GLOB '*[^0-9a-f]*'
    ),
    continuation_count INTEGER NOT NULL CHECK (continuation_count BETWEEN 0 AND 20),
    total_count INTEGER NOT NULL CHECK (total_count BETWEEN 0 AND 20),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, client_kind, source_session_id)
);

CREATE TABLE enno_resume_tokens (
    token_hash TEXT PRIMARY KEY CHECK (
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    repository_root TEXT NOT NULL,
    route_epoch INTEGER NOT NULL CHECK (typeof(route_epoch) = 'integer' AND route_epoch >= 0),
    client_kind TEXT NOT NULL CHECK (client_kind IN ('codex', 'claude', 'opencode', 'dsh')),
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
    owner_client_kind TEXT NOT NULL CHECK (owner_client_kind IN ('codex', 'claude', 'opencode', 'dsh')),
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

CREATE TABLE enno_advisory_rounds (
    round_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (
        typeof(contract_revision) = 'integer' AND contract_revision >= 1
    ),
    mutation_revision INTEGER NOT NULL CHECK (
        typeof(mutation_revision) = 'integer' AND mutation_revision >= 0
    ),
    phase TEXT NOT NULL CHECK (phase IN ('ideal', 'planning', 'final_review')),
    input_digest TEXT NOT NULL CHECK (
        length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
    ),
    policy_version INTEGER NOT NULL CHECK (
        typeof(policy_version) = 'integer' AND policy_version = 1
    ),
    source TEXT NOT NULL CHECK (source = 'host_reported'),
    state TEXT NOT NULL CHECK (state IN ('advice_submitted', 'aggregated', 'consumed')),
    degraded INTEGER NOT NULL CHECK (typeof(degraded) = 'integer' AND degraded IN (0, 1)),
    aggregate_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, contract_revision, mutation_revision, phase, input_digest)
);

CREATE INDEX idx_enno_advisory_rounds_current
ON enno_advisory_rounds(run_id, contract_revision, mutation_revision, phase, state);

CREATE TABLE enno_advisory_contributions (
    round_id TEXT NOT NULL REFERENCES enno_advisory_rounds(round_id) ON DELETE CASCADE,
    slot_id TEXT NOT NULL CHECK (length(slot_id) BETWEEN 1 AND 100),
    slot_rank INTEGER NOT NULL CHECK (
        typeof(slot_rank) = 'integer' AND slot_rank BETWEEN 0 AND 2
    ),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'timeout', 'unavailable')),
    contribution_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (round_id, slot_id),
    UNIQUE (round_id, slot_rank)
);

CREATE INDEX idx_enno_advisory_contributions_round
ON enno_advisory_contributions(round_id, slot_rank);

INSERT INTO enno_contracts SELECT * FROM __kiokuko_023_enno_contracts;
INSERT INTO enno_work_units SELECT * FROM __kiokuko_023_enno_work_units;
INSERT INTO enno_verifier_runs SELECT * FROM __kiokuko_023_enno_verifier_runs;
INSERT INTO enno_operation_receipts SELECT * FROM __kiokuko_023_enno_operation_receipts;
INSERT INTO enno_client_continuations SELECT * FROM __kiokuko_023_enno_client_continuations;
INSERT INTO enno_resume_tokens SELECT * FROM __kiokuko_023_enno_resume_tokens;
INSERT INTO enno_execution_leases SELECT * FROM __kiokuko_023_enno_execution_leases;
INSERT INTO enno_advisory_rounds SELECT * FROM __kiokuko_023_enno_advisory_rounds;
INSERT INTO enno_advisory_contributions SELECT * FROM __kiokuko_023_enno_advisory_contributions;

DROP TABLE __kiokuko_023_enno_advisory_contributions;
DROP TABLE __kiokuko_023_enno_advisory_rounds;
DROP TABLE __kiokuko_023_enno_client_continuations;
DROP TABLE __kiokuko_023_enno_execution_leases;
DROP TABLE __kiokuko_023_enno_operation_receipts;
DROP TABLE __kiokuko_023_enno_resume_tokens;
DROP TABLE __kiokuko_023_enno_verifier_runs;
DROP TABLE __kiokuko_023_enno_work_units;
DROP TABLE __kiokuko_023_enno_contracts;
