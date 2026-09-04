-- Durable, post-completion memory finalization from the canonical DSH log.
--
-- The DSH log remains the source of truth. Kiokuko stores only the job state,
-- provenance/digests, usage accounting, and the resulting self-contained
-- memory entries. A failed finalizer therefore cannot veto DSH completion or
-- session-log export, and a completed finalization survives DSH archiving.

CREATE TABLE dsh_run_log_boundaries (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    source_start_seq INTEGER NOT NULL CHECK (source_start_seq >= 0),
    source_start_turn INTEGER NOT NULL CHECK (source_start_turn >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_dsh_run_log_boundaries_session
    ON dsh_run_log_boundaries(dsh_session_id, source_start_seq);

CREATE TRIGGER dsh_run_log_boundaries_run_guard
BEFORE INSERT ON dsh_run_log_boundaries
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM ledger_runs AS run
         WHERE run.run_id = NEW.run_id
           AND run.workspace = NEW.workspace
           AND run.dsh_session_id = NEW.dsh_session_id
           AND run.status IN ('intake', 'active')
    ) THEN RAISE(ABORT, 'log boundary requires its active DSH run') END;
END;

CREATE TABLE dsh_memory_finalizations (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    dsh_session_id TEXT NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 256),
    source_start_seq INTEGER NOT NULL CHECK (source_start_seq >= 0),
    source_end_seq INTEGER NOT NULL CHECK (source_end_seq >= source_start_seq),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    log_event_count INTEGER CHECK (log_event_count IS NULL OR log_event_count >= 0),
    log_digest TEXT CHECK (log_digest IS NULL OR length(log_digest) = 64),
    capsule_hash TEXT CHECK (capsule_hash IS NULL OR length(capsule_hash) = 64),
    capsule_bytes INTEGER CHECK (capsule_bytes IS NULL OR capsule_bytes BETWEEN 1 AND 65536),
    provider TEXT,
    model TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
    last_error_code TEXT,
    last_error_message TEXT,
    scheduled_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_dsh_memory_finalizations_status
    ON dsh_memory_finalizations(status, scheduled_at);
CREATE INDEX idx_dsh_memory_finalizations_session
    ON dsh_memory_finalizations(dsh_session_id, scheduled_at);

CREATE TRIGGER dsh_memory_finalizations_run_guard
BEFORE INSERT ON dsh_memory_finalizations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM ledger_runs AS run
         WHERE run.run_id = NEW.run_id
           AND run.workspace = NEW.workspace
           AND run.dsh_session_id = NEW.dsh_session_id
           AND run.status = 'completed'
    ) THEN RAISE(ABORT, 'memory finalization requires its completed DSH run') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
          FROM dsh_run_log_boundaries AS boundary
         WHERE boundary.run_id = NEW.run_id
           AND boundary.workspace = NEW.workspace
           AND boundary.dsh_session_id = NEW.dsh_session_id
           AND boundary.source_start_seq = NEW.source_start_seq
    ) THEN RAISE(ABORT, 'memory finalization requires its bound DSH log start') END;
END;

CREATE TRIGGER dsh_memory_finalizations_range_guard
BEFORE UPDATE OF run_id, workspace, dsh_session_id, source_start_seq, source_end_seq
ON dsh_memory_finalizations
BEGIN
    SELECT RAISE(ABORT, 'memory finalization source range is immutable');
END;

CREATE TRIGGER dsh_run_log_boundaries_update_guard
BEFORE UPDATE ON dsh_run_log_boundaries
BEGIN
    SELECT CASE WHEN NEW.run_id <> OLD.run_id
                      OR NEW.workspace <> OLD.workspace
                      OR NEW.dsh_session_id <> OLD.dsh_session_id
        THEN RAISE(ABORT, 'log boundary identity is immutable') END;
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM dsh_memory_finalizations AS job WHERE job.run_id = OLD.run_id
    ) THEN RAISE(ABORT, 'scheduled log boundary is immutable') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM ledger_runs AS run
         WHERE run.run_id = OLD.run_id AND run.status IN ('intake', 'active')
    ) THEN RAISE(ABORT, 'only an active DSH run boundary can be refined') END;
END;

CREATE TABLE dsh_memory_finalization_entries (
    run_id TEXT NOT NULL REFERENCES dsh_memory_finalizations(run_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal),
    UNIQUE (run_id, entry_id)
);

CREATE INDEX idx_dsh_memory_finalization_entries_entry
    ON dsh_memory_finalization_entries(entry_id, run_id);
