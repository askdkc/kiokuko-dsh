-- Retain each completed source epoch under its real ledger run identity.
-- The migration runner already owns BEGIN IMMEDIATE with foreign keys enabled.
-- Plain temporary copies avoid both parent-table rename rewriting and DROP cascades.
CREATE TEMP TABLE migration_042_memory_episodes AS SELECT run_id,workspace,signature,evidence_digest,episode_json,overview_entry_id,created_at FROM memory_episodes;
CREATE TEMP TABLE migration_042_memory_episode_entries AS SELECT run_id,entry_id FROM memory_episode_entries;
CREATE TEMP TABLE migration_042_memory_evolution_jobs AS SELECT id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,attempts,claim_token,lease_until,settings_generation,reason,created_at,updated_at FROM memory_evolution_jobs;
CREATE TEMP TABLE migration_042_memory_evolution_calls AS SELECT id,job_id,trigger_run,workspace,utc_day,input_bytes,input_tokens,output_tokens,duration_ms,outcome,created_at FROM memory_evolution_calls;
CREATE TEMP TABLE migration_042_memory_evolution_skips AS SELECT run_id,workspace,reason FROM memory_evolution_skips;

-- Remove dependent tables first; the copies have no foreign keys.
DROP TABLE memory_episode_entries;
DROP TABLE memory_evolution_calls;
DROP TABLE memory_episodes;
DROP TABLE memory_evolution_jobs;
DROP TABLE memory_evolution_skips;

CREATE TABLE memory_episodes (
 run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 workspace TEXT NOT NULL,
 signature TEXT NOT NULL,
 evidence_digest TEXT NOT NULL,
 episode_json TEXT NOT NULL,
 overview_entry_id TEXT,
 created_at TEXT NOT NULL,
 source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
 PRIMARY KEY(run_id,source_epoch)
);

CREATE TABLE memory_episode_entries (
 run_id TEXT NOT NULL,
 entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
 PRIMARY KEY(run_id,source_epoch,entry_id),
 FOREIGN KEY(run_id,source_epoch) REFERENCES memory_episodes(run_id,source_epoch) ON DELETE CASCADE
);

CREATE TABLE memory_evolution_jobs (
 id TEXT PRIMARY KEY,
 workspace TEXT NOT NULL,
 trigger_run TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
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
 updated_at TEXT NOT NULL,
 source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
 UNIQUE(trigger_run,source_epoch)
);

CREATE TABLE memory_evolution_calls (
 id TEXT PRIMARY KEY,
 job_id TEXT REFERENCES memory_evolution_jobs(id) ON DELETE SET NULL,
 trigger_run TEXT NOT NULL,
 workspace TEXT NOT NULL,
 utc_day TEXT NOT NULL,
 input_bytes INTEGER NOT NULL,
 input_tokens INTEGER,
 output_tokens INTEGER,
 duration_ms INTEGER,
 outcome TEXT NOT NULL,
 created_at TEXT NOT NULL,
 source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
 UNIQUE(trigger_run,source_epoch)
);

CREATE TABLE memory_evolution_skips (
 run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 workspace TEXT NOT NULL,
 reason TEXT NOT NULL,
 source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
 PRIMARY KEY(run_id,source_epoch)
);

INSERT INTO memory_episodes(run_id,workspace,signature,evidence_digest,episode_json,overview_entry_id,created_at,source_epoch)
 SELECT run_id,workspace,signature,evidence_digest,episode_json,overview_entry_id,created_at,1 FROM migration_042_memory_episodes;
INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,attempts,claim_token,lease_until,settings_generation,reason,created_at,updated_at,source_epoch)
 SELECT id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,attempts,claim_token,lease_until,settings_generation,reason,created_at,updated_at,1 FROM migration_042_memory_evolution_jobs;
INSERT INTO memory_evolution_skips(run_id,workspace,reason,source_epoch)
 SELECT run_id,workspace,reason,1 FROM migration_042_memory_evolution_skips;
INSERT INTO memory_episode_entries(run_id,entry_id,source_epoch)
 SELECT run_id,entry_id,1 FROM migration_042_memory_episode_entries;
INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,input_tokens,output_tokens,duration_ms,outcome,created_at,source_epoch)
 SELECT id,job_id,trigger_run,workspace,utc_day,input_bytes,input_tokens,output_tokens,duration_ms,outcome,created_at,1 FROM migration_042_memory_evolution_calls;
DROP TABLE migration_042_memory_episodes;
DROP TABLE migration_042_memory_episode_entries;
DROP TABLE migration_042_memory_evolution_jobs;
DROP TABLE migration_042_memory_evolution_calls;
DROP TABLE migration_042_memory_evolution_skips;

CREATE INDEX memory_episodes_signature ON memory_episodes(workspace,signature,created_at);
CREATE INDEX memory_evolution_jobs_state ON memory_evolution_jobs(state,created_at);
CREATE INDEX memory_evolution_calls_budget ON memory_evolution_calls(workspace,utc_day);

CREATE TRIGGER memory_episode_identity_immutable
BEFORE UPDATE OF run_id,source_epoch,workspace,signature,evidence_digest,episode_json ON memory_episodes
BEGIN SELECT RAISE(ABORT, 'episode identity is immutable'); END;

CREATE TRIGGER memory_episode_overview_immutable
BEFORE UPDATE OF overview_entry_id ON memory_episodes
WHEN OLD.overview_entry_id IS NOT NULL AND NEW.overview_entry_id IS NOT OLD.overview_entry_id
BEGIN SELECT RAISE(ABORT, 'episode overview identity is immutable'); END;

CREATE TRIGGER memory_evolution_job_input_immutable BEFORE UPDATE OF id,workspace,trigger_run,source_epoch,signature,kind,input_json,seen_json,input_digest,model_json,algorithm ON memory_evolution_jobs
WHEN NOT(EXISTS(SELECT 1 FROM memory_forget_jobs WHERE kind='evolution' AND id=OLD.id)
 AND NEW.id=OLD.id AND NEW.workspace=OLD.workspace AND NEW.trigger_run=OLD.trigger_run AND NEW.source_epoch=OLD.source_epoch AND NEW.signature=OLD.signature
 AND NEW.kind=OLD.kind AND NEW.input_digest=OLD.input_digest AND NEW.model_json=OLD.model_json AND NEW.algorithm=OLD.algorithm
 AND NEW.input_json='[]' AND NEW.seen_json='[]')
BEGIN SELECT RAISE(ABORT,'evolution job input is immutable'); END;

CREATE TRIGGER lifecycle_reference_memory_episodes_insert AFTER INSERT ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;

CREATE TRIGGER lifecycle_reference_memory_episodes_update AFTER UPDATE ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;

CREATE TRIGGER lifecycle_reference_memory_episodes_delete AFTER DELETE ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;

CREATE TRIGGER lifecycle_reference_memory_episode_entries_insert AFTER INSERT ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;

CREATE TRIGGER lifecycle_reference_memory_episode_entries_update AFTER UPDATE ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;

CREATE TRIGGER lifecycle_reference_memory_episode_entries_delete AFTER DELETE ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
