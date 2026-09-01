-- Successful Akinator narrowing paths are durable evidence for Curator.
-- Retrieval impressions are deliberately excluded: only checkpointed runs can
-- insert rows into this table through the application service.
CREATE TABLE akinator_reasoning_paths (
    path_id TEXT PRIMARY KEY,
    concept_key TEXT NOT NULL CHECK (
        length(concept_key) = 64
        AND concept_key NOT GLOB '*[^0-9a-f]*'
    ),
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    intake_session_id TEXT NOT NULL REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    task_type TEXT NOT NULL,
    intent TEXT NOT NULL,
    hypotheses_json TEXT NOT NULL,
    question_path_json TEXT NOT NULL,
    selected_action TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    stop_conditions_json TEXT NOT NULL,
    silo_completeness REAL NOT NULL CHECK (silo_completeness >= 0 AND silo_completeness <= 1),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'interrupted')),
    qualified INTEGER NOT NULL CHECK (qualified IN (0, 1)),
    disqualification_reasons_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, entry_id, entry_revision)
);

CREATE INDEX idx_akinator_reasoning_paths_concept
    ON akinator_reasoning_paths(concept_key, qualified, created_at DESC);

CREATE INDEX idx_akinator_reasoning_paths_entry
    ON akinator_reasoning_paths(entry_id, entry_revision, created_at DESC);

CREATE TRIGGER akinator_reasoning_paths_link_guard
BEFORE INSERT ON akinator_reasoning_paths
BEGIN
    SELECT RAISE(ABORT, 'akinator reasoning path link mismatch')
    WHERE NOT EXISTS (
        SELECT 1
          FROM run_intakes AS ri
          JOIN ledger_runs AS lr ON lr.run_id = ri.run_id
          JOIN akinator_sessions AS a ON a.id = ri.session_id
         WHERE ri.run_id = NEW.run_id
           AND ri.session_id = NEW.intake_session_id
           AND lr.workspace = NEW.workspace
           AND a.workspace = NEW.workspace
    ) OR NOT EXISTS (
        SELECT 1
        FROM entries AS e
        JOIN entry_revisions AS er
          ON er.entry_id = e.id AND er.revision = NEW.entry_revision
         WHERE e.id = NEW.entry_id
           AND er.workspace IN (NEW.workspace, 'global')
    );
END;
