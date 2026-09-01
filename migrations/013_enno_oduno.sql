-- Add phase-scoped discovery attempts while preserving every v9 intake attempt.
ALTER TABLE agent_task_skill_discovery_attempts RENAME TO agent_task_skill_discovery_attempts_v9;

CREATE TABLE agent_task_skill_discovery_attempts (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('intake', 'zenki')),
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
    PRIMARY KEY (run_id, phase),
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

INSERT INTO agent_task_skill_discovery_attempts (
    run_id, phase, request_digest, state, summary_json, failure_json, started_at, finished_at
)
SELECT run_id, 'intake', request_digest, state, summary_json, failure_json, started_at, finished_at
FROM agent_task_skill_discovery_attempts_v9;

DROP TABLE agent_task_skill_discovery_attempts_v9;

CREATE TABLE enno_contracts (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    orchestration_session_id TEXT NOT NULL CHECK (length(orchestration_session_id) BETWEEN 1 AND 256),
    client_kind TEXT CHECK (client_kind IS NULL OR client_kind IN ('codex', 'claude', 'opencode')),
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

CREATE TRIGGER enno_client_binding_update_guard
BEFORE UPDATE OF client_kind, client_version, client_session_id ON enno_contracts
WHEN OLD.client_session_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'enno client binding is immutable')
    WHERE NEW.client_kind IS NOT OLD.client_kind
       OR NEW.client_version IS NOT OLD.client_version
       OR NEW.client_session_id IS NOT OLD.client_session_id;
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
    status TEXT NOT NULL CHECK (status IN ('started', 'passed', 'failed', 'timeout', 'spawn_failed')),
    exit_code INTEGER,
    signal TEXT,
    duration_ms INTEGER,
    stdout_preview TEXT,
    stderr_preview TEXT,
    stdout_digest TEXT,
    stderr_digest TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (run_id, contract_revision, work_unit_id)
        REFERENCES enno_work_units(run_id, contract_revision, work_unit_id),
    CHECK (
        (status = 'started' AND finished_at IS NULL AND duration_ms IS NULL)
        OR (status <> 'started' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL AND duration_ms >= 0)
    )
);

CREATE INDEX idx_enno_verifier_runs_freshness
ON enno_verifier_runs(run_id, contract_revision, mutation_revision, status, finished_at DESC);

CREATE TABLE enno_operation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('plan_submit', 'answer', 'work_report', 'finish')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    request_digest TEXT NOT NULL CHECK (
        length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
    response_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK (
        (state = 'started' AND response_json IS NULL AND finished_at IS NULL)
        OR (state = 'completed' AND typeof(response_json) = 'text' AND finished_at IS NOT NULL)
    ),
    PRIMARY KEY (run_id, operation, idempotency_key)
);

CREATE TABLE enno_client_continuations (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    client_kind TEXT NOT NULL CHECK (client_kind IN ('codex', 'claude', 'opencode')),
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
