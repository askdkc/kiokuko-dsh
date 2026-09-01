ALTER TABLE enno_contracts
ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN ('oduno_ideal', 'oduno_meditation'));

ALTER TABLE enno_contracts
ADD COLUMN ideal_json TEXT;

ALTER TABLE enno_contracts
ADD COLUMN meditation_json TEXT;

ALTER TABLE enno_operation_receipts RENAME TO enno_operation_receipts_v13;

CREATE TABLE enno_operation_receipts (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN (
        'ideal_submit', 'plan_submit', 'answer', 'work_report', 'finish', 'meditation_submit'
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
FROM enno_operation_receipts_v13;

DROP TABLE enno_operation_receipts_v13;
