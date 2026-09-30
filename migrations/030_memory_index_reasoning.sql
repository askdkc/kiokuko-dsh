CREATE TABLE memory_index_settings (
 workspace TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('active','observe','off')),
 generation INTEGER NOT NULL DEFAULT 1, index_generation INTEGER NOT NULL DEFAULT 0, config_digest TEXT, model_json TEXT
);
CREATE TABLE memory_index_sources (
 entry_id TEXT NOT NULL, revision INTEGER NOT NULL, workspace TEXT NOT NULL,
 content_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(entry_id,revision)
);
CREATE TABLE memory_index_facts (
 entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, workspace TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('atomic','bridge')),
 manifest_json TEXT NOT NULL, input_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','held')),
 PRIMARY KEY(entry_id,revision), UNIQUE(workspace,input_digest)
);
CREATE TABLE memory_index_entities (
 entry_id TEXT NOT NULL, revision INTEGER NOT NULL, workspace TEXT NOT NULL,
 type TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(entry_id,revision,type,value),
 FOREIGN KEY(entry_id,revision) REFERENCES memory_index_facts(entry_id,revision) ON DELETE CASCADE
);
CREATE INDEX memory_index_entity_lookup ON memory_index_entities(workspace,type,value);
CREATE TABLE memory_index_jobs (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, input_json TEXT NOT NULL, input_digest TEXT NOT NULL,
 model_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','held','completed')), stage INTEGER NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 2), priority INTEGER NOT NULL DEFAULT 1,
 drafts_json TEXT NOT NULL DEFAULT '[]', peers_json TEXT NOT NULL DEFAULT '[]', peers_digest TEXT, verdicts_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT, lease_until TEXT, settings_generation INTEGER, reason TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_index_calls (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES memory_index_jobs(id), stage INTEGER NOT NULL,
 workspace TEXT NOT NULL, utc_day TEXT NOT NULL, outcome TEXT NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, UNIQUE(job_id,stage)
);
CREATE INDEX memory_index_budget ON memory_index_calls(workspace,utc_day);
CREATE TRIGGER memory_index_manifest_immutable BEFORE UPDATE OF entry_id,revision,workspace,role,manifest_json,input_digest ON memory_index_facts
BEGIN SELECT RAISE(ABORT,'index manifest is immutable'); END;
CREATE TRIGGER memory_index_job_immutable BEFORE UPDATE OF id,workspace,input_json,input_digest,model_json ON memory_index_jobs
BEGIN SELECT RAISE(ABORT,'index job input is immutable'); END;

CREATE TRIGGER memory_index_peers_immutable BEFORE UPDATE OF peers_json,peers_digest ON memory_index_jobs WHEN OLD.peers_digest IS NOT NULL BEGIN SELECT RAISE(ABORT,'index peer snapshot is immutable'); END;
