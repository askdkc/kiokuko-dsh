-- Preserve old decisions and distinguish them from the progress-based policy.
DROP INDEX idx_dsh_loop_guard_claims_scope;
ALTER TABLE dsh_loop_guard_claims RENAME TO dsh_loop_guard_claims_v1;
ALTER TABLE dsh_loop_guard_states RENAME TO dsh_loop_guard_states_v1;

CREATE TABLE dsh_loop_guard_states (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    instruction_digest TEXT CHECK (instruction_digest IS NULL OR length(instruction_digest) = 64),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    automatic_count INTEGER NOT NULL DEFAULT 0 CHECK (automatic_count >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting_user', 'blocked')),
    blocked_claim_id TEXT CHECK (blocked_claim_id IS NULL OR length(blocked_claim_id) = 64),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, dsh_session_id)
);

CREATE TABLE dsh_loop_guard_claims (
    claim_id TEXT PRIMARY KEY CHECK (length(claim_id) = 64),
    run_id TEXT NOT NULL,
    dsh_session_id TEXT NOT NULL,
    instruction_digest TEXT NOT NULL CHECK (length(instruction_digest) = 64),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    decision TEXT NOT NULL CHECK (decision IN ('deliver', 'replan', 'wait_user', 'blocked')),
    resolution TEXT CHECK (resolution IS NULL OR resolution IN ('user_answer', 'manual_user', 'superseded')),
    created_at TEXT NOT NULL,
    question_asked_at TEXT,
    progress_digest TEXT CHECK (progress_digest IS NULL OR length(progress_digest) = 64),
    policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version IN (1, 2)),
    reason TEXT,
    resolved_at TEXT,
    FOREIGN KEY (run_id, dsh_session_id)
      REFERENCES dsh_loop_guard_states(run_id, dsh_session_id) ON DELETE CASCADE
);

CREATE INDEX idx_dsh_loop_guard_claims_scope
    ON dsh_loop_guard_claims(run_id, dsh_session_id, generation, created_at);

INSERT INTO dsh_loop_guard_states SELECT * FROM dsh_loop_guard_states_v1;
INSERT INTO dsh_loop_guard_claims (
    claim_id, run_id, dsh_session_id, instruction_digest, generation, ordinal,
    decision, resolution, created_at, question_asked_at, resolved_at
)
SELECT claim_id, run_id, dsh_session_id, instruction_digest, generation, ordinal,
       decision, resolution, created_at, question_asked_at, resolved_at
FROM dsh_loop_guard_claims_v1;

DROP TABLE dsh_loop_guard_claims_v1;
DROP TABLE dsh_loop_guard_states_v1;

CREATE INDEX idx_dsh_loop_guard_progress
    ON dsh_loop_guard_claims(run_id, dsh_session_id, generation, progress_digest)
    WHERE policy_version = 2;

ALTER TABLE dsh_completion_runs ADD COLUMN evidence_required INTEGER NOT NULL DEFAULT 0
    CHECK (evidence_required IN (0, 1));
ALTER TABLE dsh_completion_receipts ADD COLUMN verified_generation INTEGER
    CHECK (verified_generation > 0);

-- Reserve delivery before crossing into the native inbox. A missing settlement
-- after reservation is uncertain and must not cause an automatic resend.
ALTER TABLE dsh_continuation_outbox ADD COLUMN delivery_reserved_at TEXT;


DROP INDEX idx_dsh_boundary_jobs_pending;
DROP INDEX idx_dsh_boundary_jobs_stage;
ALTER TABLE dsh_boundary_jobs RENAME TO dsh_boundary_jobs_v1;

CREATE TABLE dsh_boundary_jobs (
    job_id TEXT PRIMARY KEY CHECK (length(job_id) = 64),
    receipt_id TEXT NOT NULL REFERENCES dsh_turn_receipts(receipt_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'waiting_user', 'blocked', 'failed_retryable', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    progress_digest TEXT CHECK (progress_digest IS NULL OR length(progress_digest) = 64),
    progress_count INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
    progress_claim_attempt INTEGER CHECK (progress_claim_attempt IS NULL OR progress_claim_attempt >= 1),
    progress_waiting INTEGER NOT NULL DEFAULT 0 CHECK (progress_waiting IN (0,1))
);

CREATE INDEX idx_dsh_boundary_jobs_pending
    ON dsh_boundary_jobs(status, available_at, created_at);

CREATE UNIQUE INDEX idx_dsh_boundary_jobs_stage
    ON dsh_boundary_jobs(receipt_id, kind);

INSERT INTO dsh_boundary_jobs SELECT * FROM dsh_boundary_jobs_v1;
DROP TABLE dsh_boundary_jobs_v1;

-- Only a pending delivery withheld solely by the old repetition limit can
-- resume. Do not release prior approvals, errors or uncertain dispatches.
UPDATE dsh_boundary_jobs SET status = 'pending', attempt_count = 0
WHERE kind = 'delivery' AND status = 'waiting_user' AND last_error_code IS NULL
  AND EXISTS (
    SELECT 1 FROM dsh_continuation_outbox o
    JOIN dsh_loop_guard_claims c ON c.claim_id = o.continuation_id
    JOIN ledger_runs r ON r.run_id = o.run_id
    WHERE o.receipt_id = dsh_boundary_jobs.receipt_id AND o.run_id = dsh_boundary_jobs.run_id
      AND o.status = 'pending' AND o.message_form = 'continuation' AND r.status = 'active'
      AND c.decision = 'wait_user' AND c.resolution IS NULL AND c.policy_version = 1
  );

-- A native question is shown and answered at most once for its captured turn.
-- Store identities and disposition only. Human answer text belongs to DSH.
CREATE TABLE dsh_clarification_claims (
    question_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    native_turn INTEGER NOT NULL CHECK(native_turn > 0),
    status TEXT NOT NULL CHECK(status IN ('waiting', 'answer_reserved', 'unresolved')),
    answer_id TEXT
);
CREATE UNIQUE INDEX idx_dsh_clarification_waiting
    ON dsh_clarification_claims(session_id) WHERE status = 'waiting';
CREATE INDEX idx_dsh_clarification_turn
    ON dsh_clarification_claims(session_id, native_turn);
