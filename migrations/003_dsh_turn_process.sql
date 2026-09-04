-- Durable one-turn/one-responsibility orchestration.
--
-- An intent is prepared before an Enno operation starts.  The completion
-- trigger below joins that intent to the authoritative Enno receipt so the
-- domain mutation, handoff, boundary job, outbox item, and turn seal become
-- visible in the same SQLite commit.

CREATE TABLE dsh_turn_intents (
    receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 64),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    native_turn INTEGER NOT NULL CHECK (native_turn >= 1),
    phase TEXT NOT NULL CHECK (phase IN (
        'intake', 'ideal', 'planning', 'confirmation', 'work_unit',
        'final_verification', 'final_review', 'meditation', 'complete'
    )),
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    work_unit_key TEXT NOT NULL DEFAULT '',
    input_digest TEXT NOT NULL CHECK (length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
    operation TEXT NOT NULL CHECK (operation IN (
        'ideal_submit', 'advice_submit', 'plan_submit', 'answer', 'work_report',
        'finish', 'meditation_submit', 'verify_prepare'
    )),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    continuation_id TEXT NOT NULL UNIQUE CHECK (length(continuation_id) = 64),
    boundary_job_id TEXT NOT NULL UNIQUE CHECK (length(boundary_job_id) = 64),
    created_at TEXT NOT NULL,
    UNIQUE (run_id, operation, idempotency_key),
    UNIQUE (dsh_session_id, native_turn)
);

CREATE TABLE dsh_turn_receipts (
    receipt_id TEXT PRIMARY KEY REFERENCES dsh_turn_intents(receipt_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    native_turn INTEGER NOT NULL CHECK (native_turn >= 1),
    phase TEXT NOT NULL,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    work_unit_key TEXT NOT NULL DEFAULT '',
    input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
    outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('applied', 'retry', 'clarify', 'waiting_user', 'infrastructure_error')),
    next_action TEXT,
    enno_operation TEXT,
    enno_idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (dsh_session_id, native_turn),
    CHECK ((enno_operation IS NULL) = (enno_idempotency_key IS NULL))
);

CREATE INDEX idx_dsh_turn_receipts_run
    ON dsh_turn_receipts(run_id, contract_revision, native_turn);

-- Domain effects are idempotent by logical phase input. Expected validation
-- failures are attempt receipts and may repeat that input on a later turn.
CREATE UNIQUE INDEX idx_dsh_turn_receipts_applied_identity
    ON dsh_turn_receipts(run_id, phase, contract_revision, work_unit_key, input_digest)
    WHERE outcome_kind = 'applied';

CREATE TABLE dsh_turn_handoffs (
    receipt_id TEXT PRIMARY KEY REFERENCES dsh_turn_receipts(receipt_id) ON DELETE CASCADE,
    handoff_json TEXT NOT NULL CHECK (length(CAST(handoff_json AS BLOB)) BETWEEN 2 AND 32768),
    created_at TEXT NOT NULL
);

CREATE TABLE dsh_boundary_jobs (
    job_id TEXT PRIMARY KEY CHECK (length(job_id) = 64),
    receipt_id TEXT NOT NULL REFERENCES dsh_turn_receipts(receipt_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'waiting_user', 'failed_retryable', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    owner_nonce TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_dsh_boundary_jobs_pending
    ON dsh_boundary_jobs(status, available_at, created_at);

CREATE UNIQUE INDEX idx_dsh_boundary_jobs_stage
    ON dsh_boundary_jobs(receipt_id, kind);

CREATE TABLE dsh_continuation_outbox (
    continuation_id TEXT PRIMARY KEY CHECK (length(continuation_id) = 64),
    receipt_id TEXT NOT NULL UNIQUE REFERENCES dsh_turn_receipts(receipt_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    causal_revision INTEGER NOT NULL CHECK (causal_revision >= 1),
    message_json TEXT NOT NULL CHECK (length(CAST(message_json AS BLOB)) BETWEEN 2 AND 32768),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'observed', 'superseded')),
    dispatched_at TEXT,
    observed_seq INTEGER CHECK (observed_seq IS NULL OR observed_seq >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_dsh_continuation_outbox_pending
    ON dsh_continuation_outbox(dsh_session_id, status, created_at);

CREATE TABLE dsh_temporary_memories (
    memory_id TEXT PRIMARY KEY CHECK (length(memory_id) = 64),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
    input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
    failure_digest TEXT NOT NULL CHECK (length(failure_digest) = 64),
    failure_count INTEGER NOT NULL DEFAULT 1 CHECK (failure_count >= 1),
    weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 1.0),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    memory_json TEXT NOT NULL CHECK (length(CAST(memory_json AS BLOB)) BETWEEN 2 AND 65536),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, phase, contract_revision, input_digest, failure_digest)
);

CREATE TABLE dsh_input_claim_backups (
    claim_id TEXT PRIMARY KEY CHECK (length(claim_id) = 64),
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    native_turn INTEGER NOT NULL CHECK (native_turn >= 1),
    message_payload BLOB NOT NULL,
    provider_started INTEGER NOT NULL DEFAULT 0 CHECK (provider_started IN (0, 1)),
    side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effect_started IN (0, 1)),
    recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count BETWEEN 0 AND 1),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'consumed', 'recoverable', 'recovered', 'unsafe', 'degraded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (dsh_session_id, native_turn)
);

CREATE TABLE dsh_session_cache_health (
    dsh_session_id TEXT PRIMARY KEY CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    observed_through INTEGER NOT NULL DEFAULT -1 CHECK (observed_through >= -1),
    mirrored_through INTEGER NOT NULL DEFAULT -1 CHECK (mirrored_through >= -1),
    native_durable_through INTEGER NOT NULL DEFAULT -1 CHECK (native_durable_through >= -1),
    health TEXT NOT NULL CHECK (health IN ('healthy', 'catching_up', 'degraded', 'blocked_legacy', 'archive_unsafe')),
    last_error_code TEXT,
    last_error_message TEXT,
    updated_at TEXT NOT NULL
);

CREATE TRIGGER dsh_turn_receipt_from_enno_completion
AFTER UPDATE OF state, response_json ON enno_operation_receipts
WHEN NEW.state = 'completed' AND OLD.state <> 'completed'
  AND EXISTS (
      SELECT 1 FROM dsh_turn_intents AS intent
       WHERE intent.run_id = NEW.run_id
         AND intent.operation = NEW.operation
         AND intent.idempotency_key = NEW.idempotency_key
  )
BEGIN
    INSERT INTO dsh_turn_receipts (
        receipt_id, run_id, dsh_session_id, native_turn, phase,
        contract_revision, work_unit_key, input_digest, outcome_kind,
        next_action, enno_operation, enno_idempotency_key, created_at
    )
    SELECT intent.receipt_id, intent.run_id, intent.dsh_session_id,
           intent.native_turn, intent.phase, intent.contract_revision,
           intent.work_unit_key, intent.input_digest, 'applied',
           json_extract(NEW.response_json, '$.ennoOduno.nextAction'),
           NEW.operation, NEW.idempotency_key, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_turn_handoffs (receipt_id, handoff_json, created_at)
    SELECT intent.receipt_id,
           json_object(
               'schemaVersion', 1,
               'runId', intent.run_id,
               'phase', intent.phase,
               'revision', intent.contract_revision,
               'nextAction', json_extract(NEW.response_json, '$.ennoOduno.nextAction'),
               'source', 'enno_operation_receipt'
           ),
           NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_boundary_jobs (
        job_id, receipt_id, run_id, kind, status, available_at,
        created_at, updated_at
    )
    SELECT intent.boundary_job_id,
           intent.receipt_id, intent.run_id,
           'classify_boundary',
           'pending', NEW.finished_at, NEW.finished_at, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_continuation_outbox (
        continuation_id, receipt_id, run_id, dsh_session_id,
        causal_revision, message_json, status, created_at, updated_at
    )
    SELECT intent.continuation_id, intent.receipt_id, intent.run_id,
           intent.dsh_session_id, intent.contract_revision,
           json_object(
               'id', intent.continuation_id,
               'role', 'user',
               'content', json_array(json_object(
                   'type', 'text',
                   'text', 'Continue Kiokuko processing from nextAction: ' ||
                       coalesce(json_extract(NEW.response_json, '$.ennoOduno.nextAction'), 'complete')
               )),
               'source', json_object(
                   'kind', 'plugin', 'plugin', 'kiokuko-dsh',
                   'form', 'continuation', 'deliveryId', intent.continuation_id
               )
           ),
           CASE WHEN json_extract(NEW.response_json, '$.ennoOduno.nextAction') IN ('complete', 'report_blocker')
                THEN 'superseded' ELSE 'pending' END,
           NEW.finished_at, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;
END;
