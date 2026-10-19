-- Advisory provenance only. No diagnostic row is execution authority.
CREATE TABLE dsh_diagnostic_attempts (
 decision_id TEXT PRIMARY KEY,
 request_ref TEXT NOT NULL,
 session_id TEXT,
 native_turn INTEGER,
 run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 input_digest TEXT NOT NULL,
 document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(document_json)<=16384),
 document_digest TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX dsh_diagnostic_request ON dsh_diagnostic_attempts(request_ref,created_at);
CREATE INDEX dsh_diagnostic_session ON dsh_diagnostic_attempts(session_id,native_turn);
CREATE TABLE dsh_diagnostic_events (
 event_id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL REFERENCES dsh_diagnostic_attempts(decision_id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL,
 parent_event_id TEXT,
 reference_digest TEXT,
 target_session_id TEXT,
 document_json TEXT NOT NULL CHECK(json_valid(document_json) AND length(document_json)<=16384),
 document_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(decision_id,sequence), UNIQUE(decision_id,event_id),
 FOREIGN KEY(decision_id,parent_event_id) REFERENCES dsh_diagnostic_events(decision_id,event_id)
);
CREATE INDEX dsh_diagnostic_reference ON dsh_diagnostic_events(reference_digest,kind);
CREATE TABLE dsh_diagnostic_gaps (
 gap_id TEXT PRIMARY KEY, scope_ref TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('recording_failed','stale_binding','causal_conflict')),
 created_at TEXT NOT NULL
);
CREATE TABLE dsh_diagnostic_reviews (
 decision_id TEXT PRIMARY KEY REFERENCES dsh_diagnostic_attempts(decision_id) ON DELETE CASCADE,
 verdict TEXT NOT NULL CHECK(verdict IN ('false_stop','justified_stop')),
 review_ref TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER dsh_diagnostic_attempt_immutable BEFORE UPDATE ON dsh_diagnostic_attempts
BEGIN SELECT RAISE(ABORT,'diagnostic attempt is immutable'); END;
CREATE TRIGGER dsh_diagnostic_event_immutable BEFORE UPDATE ON dsh_diagnostic_events
BEGIN SELECT RAISE(ABORT,'diagnostic event is immutable'); END;
CREATE TRIGGER dsh_diagnostic_review_immutable BEFORE UPDATE ON dsh_diagnostic_reviews
BEGIN SELECT RAISE(ABORT,'diagnostic review is immutable'); END;
