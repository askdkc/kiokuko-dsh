-- Append-only extension: old finalization jobs keep extraction version 1.
ALTER TABLE dsh_memory_finalizations ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1 CHECK (extraction_version IN (1, 2));
ALTER TABLE dsh_memory_finalizations ADD COLUMN episode_error TEXT;
DROP TRIGGER dsh_memory_finalizations_run_guard;
CREATE TRIGGER dsh_memory_finalizations_run_guard
BEFORE INSERT ON dsh_memory_finalizations
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM ledger_runs r WHERE r.run_id = NEW.run_id AND r.workspace = NEW.workspace
   AND r.dsh_session_id = NEW.dsh_session_id
   AND (r.status = 'completed' OR r.status = 'failed' AND NEW.extraction_version = 2)
 ) THEN RAISE(ABORT, 'memory finalization requires its terminal DSH run') END;
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM dsh_run_log_boundaries b WHERE b.run_id = NEW.run_id AND b.workspace = NEW.workspace
   AND b.dsh_session_id = NEW.dsh_session_id AND b.source_start_seq = NEW.source_start_seq
 ) THEN RAISE(ABORT, 'memory finalization requires its bound DSH log start') END;
END;
CREATE TABLE memory_evolution_settings (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 mode TEXT NOT NULL CHECK (mode IN ('active','observe','off')),
 requested_mode TEXT NOT NULL CHECK (requested_mode IN ('active','observe','off')),
 generation INTEGER NOT NULL DEFAULT 1
);
INSERT INTO memory_evolution_settings(singleton,mode,requested_mode) VALUES (1,'observe','active');
CREATE TABLE memory_episodes (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 workspace TEXT NOT NULL,
 signature TEXT NOT NULL,
 evidence_digest TEXT NOT NULL,
 episode_json TEXT NOT NULL,
 overview_entry_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX memory_episodes_signature ON memory_episodes(workspace,signature,created_at);
CREATE TABLE memory_episode_entries (
 run_id TEXT NOT NULL REFERENCES memory_episodes(run_id) ON DELETE CASCADE,
 entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 PRIMARY KEY(run_id,entry_id)
);
CREATE TABLE memory_derivations (
 entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 workspace TEXT NOT NULL,
 signature TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('episode','positive','avoidance')),
 algorithm TEXT NOT NULL,
 manifest_json TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ready','held')),
 PRIMARY KEY(entry_id,revision)
);
CREATE INDEX memory_derivations_signature ON memory_derivations(workspace,signature,kind);
CREATE TABLE memory_evolution_jobs (
 id TEXT PRIMARY KEY,
 workspace TEXT NOT NULL,
 trigger_run TEXT NOT NULL UNIQUE REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 signature TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('positive','avoidance')),
 input_json TEXT NOT NULL,
 seen_json TEXT NOT NULL,
 input_digest TEXT NOT NULL UNIQUE,
 model_json TEXT NOT NULL,
 algorithm TEXT NOT NULL DEFAULT 'episode-evolution-v1',
 state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','held','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
 claim_token TEXT,
 lease_until TEXT,
 settings_generation INTEGER,
 reason TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX memory_evolution_jobs_state ON memory_evolution_jobs(state,created_at);
CREATE TABLE memory_evolution_calls (
 id TEXT PRIMARY KEY,
 job_id TEXT REFERENCES memory_evolution_jobs(id) ON DELETE SET NULL,
 trigger_run TEXT NOT NULL UNIQUE,
 workspace TEXT NOT NULL,
 utc_day TEXT NOT NULL,
 input_bytes INTEGER NOT NULL,
 input_tokens INTEGER,
 output_tokens INTEGER,
 duration_ms INTEGER,
 outcome TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX memory_evolution_calls_budget ON memory_evolution_calls(workspace,utc_day);

CREATE TABLE memory_evolution_skips (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 workspace TEXT NOT NULL,
 reason TEXT NOT NULL
);

CREATE TRIGGER memory_evolution_extraction_version_immutable
BEFORE UPDATE OF extraction_version ON dsh_memory_finalizations
WHEN OLD.extraction_version <> NEW.extraction_version
BEGIN SELECT RAISE(ABORT, 'finalization extraction version is immutable'); END;
CREATE TRIGGER memory_episode_identity_immutable
BEFORE UPDATE OF run_id,workspace,signature,evidence_digest,episode_json ON memory_episodes
BEGIN SELECT RAISE(ABORT, 'episode identity is immutable'); END;
CREATE TRIGGER memory_evolution_job_input_immutable
BEFORE UPDATE OF id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm ON memory_evolution_jobs
BEGIN SELECT RAISE(ABORT, 'evolution job input is immutable'); END;
CREATE TRIGGER memory_episode_overview_immutable
BEFORE UPDATE OF overview_entry_id ON memory_episodes
WHEN OLD.overview_entry_id IS NOT NULL AND NEW.overview_entry_id IS NOT OLD.overview_entry_id
BEGIN SELECT RAISE(ABORT, 'episode overview identity is immutable'); END;
CREATE TRIGGER memory_derivation_manifest_immutable
BEFORE UPDATE OF entry_id,revision,workspace,signature,kind,algorithm,manifest_json,input_digest ON memory_derivations
BEGIN SELECT RAISE(ABORT, 'derivation manifest is immutable'); END;
