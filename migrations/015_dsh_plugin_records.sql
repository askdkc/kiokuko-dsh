-- Plugin information must not extend DSH's required-on-read event vocabulary.
CREATE TABLE dsh_evolution_observations (
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  dsh_session_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL CHECK (call_seq >= 0),
  observation_json TEXT NOT NULL,
  PRIMARY KEY (run_id, call_seq)
);
CREATE TRIGGER dsh_evolution_observation_identity BEFORE INSERT ON dsh_evolution_observations
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ledger_runs WHERE run_id=NEW.run_id
    AND workspace=NEW.workspace AND dsh_session_id=NEW.dsh_session_id)
    THEN RAISE(ABORT, 'observation requires its exact DSH run') END;
END;
CREATE TABLE dsh_session_notices (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  dsh_session_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'status')),
  text TEXT NOT NULL,
  anchor_seq INTEGER NOT NULL CHECK (anchor_seq >= 0),
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
);
CREATE INDEX dsh_session_notices_session ON dsh_session_notices(dsh_session_id);
CREATE TRIGGER dsh_session_notice_identity BEFORE INSERT ON dsh_session_notices
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ledger_runs WHERE run_id=NEW.run_id AND dsh_session_id=NEW.dsh_session_id)
    THEN RAISE(ABORT, 'notice requires its exact DSH run') END;
END;
