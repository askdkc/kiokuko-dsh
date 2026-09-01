CREATE TABLE ledger_runs (
    run_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    client_kind TEXT NOT NULL,
    client_version TEXT,
    source_session_id TEXT,
    parent_run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL,
    protocol_version TEXT NOT NULL,
    capture_profile TEXT NOT NULL,
    coverage_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('intake', 'active', 'completed', 'failed', 'cancelled', 'interrupted')
    ),
    title TEXT,
    task_hash TEXT,
    metadata_json TEXT NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
    last_source_sequence INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_ledger_runs_workspace_status_created_at
    ON ledger_runs(workspace, status, created_at DESC);
CREATE INDEX idx_ledger_runs_parent
    ON ledger_runs(parent_run_id);

CREATE TABLE run_intakes (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES akinator_sessions(id),
    policy_version TEXT NOT NULL,
    profile_schema_version INTEGER NOT NULL CHECK (profile_schema_version > 0),
    profile_sources_json TEXT NOT NULL,
    initial_profile_hash TEXT,
    recommended_tags_json TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    finalized_at TEXT
);

CREATE INDEX idx_run_intakes_session
    ON run_intakes(session_id);

CREATE TRIGGER run_intakes_workspace_guard
BEFORE INSERT ON run_intakes
BEGIN
    SELECT RAISE(ABORT, 'run_intakes workspace mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id)
          <> (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id);
END;

CREATE TRIGGER run_intakes_workspace_update_guard
BEFORE UPDATE OF run_id, session_id ON run_intakes
BEGIN
    SELECT RAISE(ABORT, 'run_intakes workspace mismatch')
    WHERE (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id) IS NULL
       OR (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id) IS NULL
       OR (SELECT workspace FROM ledger_runs WHERE run_id = NEW.run_id)
          <> (SELECT workspace FROM akinator_sessions WHERE id = NEW.session_id);
END;

CREATE TRIGGER run_intakes_parent_workspace_guard
BEFORE UPDATE OF workspace ON ledger_runs
WHEN EXISTS (SELECT 1 FROM run_intakes WHERE run_id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'workspace cannot change after run intake link');
END;

CREATE TRIGGER run_intakes_session_workspace_guard
BEFORE UPDATE OF workspace ON akinator_sessions
WHEN EXISTS (SELECT 1 FROM run_intakes WHERE session_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'workspace cannot change after run intake link');
END;

CREATE TABLE intake_feedback (
    feedback_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES akinator_sessions(id),
    question_id TEXT,
    profile_field TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('helpful', 'unnecessary', 'corrected')),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key),
    CHECK ((question_id IS NOT NULL) <> (profile_field IS NOT NULL))
);

CREATE INDEX idx_intake_feedback_run_created_at
    ON intake_feedback(run_id, created_at DESC);

CREATE TRIGGER intake_feedback_link_guard
BEFORE INSERT ON intake_feedback
BEGIN
    SELECT RAISE(ABORT, 'intake_feedback requires the linked run and session')
    WHERE NOT EXISTS (
        SELECT 1 FROM run_intakes
        WHERE run_id = NEW.run_id AND session_id = NEW.session_id
    );
END;

CREATE TABLE ledger_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    source_event_id TEXT,
    source_sequence INTEGER,
    event_type TEXT NOT NULL,
    source_type TEXT,
    actor TEXT NOT NULL,
    outcome TEXT,
    occurred_at TEXT,
    ingested_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    redaction_json TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    UNIQUE (run_id, sequence)
);

CREATE INDEX idx_ledger_events_run_sequence
    ON ledger_events(run_id, sequence);
CREATE UNIQUE INDEX idx_ledger_events_run_source
    ON ledger_events(run_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

CREATE TABLE ledger_evidence (
    evidence_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('command', 'test', 'file', 'diff', 'url', 'artifact')),
    locator TEXT NOT NULL,
    digest_algorithm TEXT,
    digest TEXT,
    byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
    summary TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_ledger_evidence_run_created_at
    ON ledger_evidence(run_id, created_at DESC);

CREATE TABLE context_deliveries (
    delivery_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
    intake_session_id TEXT REFERENCES akinator_sessions(id),
    task_profile_hash TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    external_sync_summary_json TEXT NOT NULL,
    char_budget INTEGER NOT NULL CHECK (char_budget >= 0),
    char_count INTEGER NOT NULL CHECK (char_count >= 0 AND char_count <= char_budget),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE INDEX idx_context_deliveries_run_created_at
    ON context_deliveries(run_id, created_at DESC);

CREATE TABLE context_delivery_entries (
    delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    rank INTEGER NOT NULL CHECK (rank > 0),
    score_components_json TEXT NOT NULL,
    selection_reason_json TEXT NOT NULL,
    PRIMARY KEY (delivery_id, entry_id),
    FOREIGN KEY (entry_id, entry_revision)
        REFERENCES entry_revisions(entry_id, revision)
);

CREATE INDEX idx_context_delivery_entries_entry
    ON context_delivery_entries(entry_id, entry_revision);

CREATE TABLE context_feedback (
    feedback_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    verdict TEXT NOT NULL CHECK (verdict IN ('helpful', 'irrelevant', 'stale', 'conflicting')),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key)
);

CREATE INDEX idx_context_feedback_run
    ON context_feedback(run_id, created_at DESC);

CREATE TABLE run_feedback (
    feedback_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    outcome TEXT,
    recommendation_code TEXT,
    recommendation_verdict TEXT CHECK (recommendation_verdict IS NULL OR recommendation_verdict IN ('accepted', 'dismissed', 'resolved')),
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, actor, idempotency_key)
);

CREATE INDEX idx_run_feedback_run_created_at
    ON run_feedback(run_id, created_at DESC);

CREATE TABLE ledger_memory_links (
    link_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    delivery_id TEXT REFERENCES context_deliveries(delivery_id) ON DELETE SET NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    created_at TEXT NOT NULL,
    CHECK (event_id IS NOT NULL OR delivery_id IS NOT NULL)
);

CREATE INDEX idx_ledger_memory_links_run
    ON ledger_memory_links(run_id, created_at DESC);
CREATE INDEX idx_ledger_memory_links_entry
    ON ledger_memory_links(entry_id);

CREATE TABLE ledger_purge_audit (
    purge_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE SET NULL,
    event_id TEXT REFERENCES ledger_events(event_id) ON DELETE SET NULL,
    delivery_id TEXT REFERENCES context_deliveries(delivery_id) ON DELETE SET NULL,
    entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('run', 'event', 'evidence', 'delivery', 'feedback', 'memory_link')),
    target_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_ledger_purge_audit_target
    ON ledger_purge_audit(target_type, target_id);

CREATE TABLE gateway_idempotency (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (
        length(key_hash) = 64
        AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64
        AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, key_hash)
);

CREATE INDEX idx_gateway_idempotency_created_at
    ON gateway_idempotency(created_at);
