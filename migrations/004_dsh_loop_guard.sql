-- Bound every plugin-owned automatic continuation across turns and restarts.
-- A claim is durable before native delivery; replaying the same claim never
-- consumes another slot.

CREATE TABLE dsh_loop_guard_states (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    instruction_digest TEXT CHECK (instruction_digest IS NULL OR length(instruction_digest) = 64),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    automatic_count INTEGER NOT NULL DEFAULT 0 CHECK (automatic_count BETWEEN 0 AND 3),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'waiting_user')),
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
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
    decision TEXT NOT NULL CHECK (decision IN ('deliver', 'wait_user')),
    resolution TEXT CHECK (resolution IS NULL OR resolution IN ('user_answer', 'manual_user', 'superseded')),
    created_at TEXT NOT NULL,
    question_asked_at TEXT,
    resolved_at TEXT,
    FOREIGN KEY (run_id, dsh_session_id)
      REFERENCES dsh_loop_guard_states(run_id, dsh_session_id) ON DELETE CASCADE
);

CREATE INDEX idx_dsh_loop_guard_claims_scope
    ON dsh_loop_guard_claims(run_id, dsh_session_id, generation, created_at);

-- Stateful host effects can also cycle successfully without advancing Enno.
-- Keep their no-progress accounting on the already leased job row.
ALTER TABLE dsh_boundary_jobs ADD COLUMN progress_digest TEXT
    CHECK (progress_digest IS NULL OR length(progress_digest) = 64);
ALTER TABLE dsh_boundary_jobs ADD COLUMN progress_count INTEGER NOT NULL DEFAULT 0
    CHECK (progress_count BETWEEN 0 AND 3);
ALTER TABLE dsh_boundary_jobs ADD COLUMN progress_claim_attempt INTEGER
    CHECK (progress_claim_attempt IS NULL OR progress_claim_attempt >= 1);
ALTER TABLE dsh_boundary_jobs ADD COLUMN progress_waiting INTEGER NOT NULL DEFAULT 0
    CHECK (progress_waiting IN (0, 1));
