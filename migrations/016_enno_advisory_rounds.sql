ALTER TABLE enno_operation_receipts RENAME TO enno_operation_receipts_v15;

CREATE TABLE enno_operation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN (
        'ideal_submit', 'advice_submit', 'plan_submit', 'answer', 'work_report', 'finish', 'meditation_submit'
    )),
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

INSERT INTO enno_operation_receipts (
    run_id, operation, idempotency_key, request_digest, state,
    response_json, created_at, finished_at
)
SELECT run_id, operation, idempotency_key, request_digest, state,
       response_json, created_at, finished_at
FROM enno_operation_receipts_v15;

DROP TABLE enno_operation_receipts_v15;

CREATE TABLE enno_advisory_rounds (
    round_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    mutation_revision INTEGER NOT NULL CHECK (mutation_revision >= 0),
    phase TEXT NOT NULL CHECK (phase IN ('ideal', 'planning', 'final_review')),
    input_digest TEXT NOT NULL CHECK (
        length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
    ),
    policy_version INTEGER NOT NULL CHECK (policy_version = 1),
    source TEXT NOT NULL CHECK (source = 'host_reported'),
    state TEXT NOT NULL CHECK (state IN ('advice_submitted', 'aggregated', 'consumed')),
    degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
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
    slot_rank INTEGER NOT NULL CHECK (slot_rank BETWEEN 0 AND 2),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'timeout', 'unavailable')),
    contribution_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (round_id, slot_id),
    UNIQUE (round_id, slot_rank)
);

CREATE INDEX idx_enno_advisory_contributions_round
ON enno_advisory_contributions(round_id, slot_rank);
