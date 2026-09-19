CREATE TABLE memory_review_control (
 workspace TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
 config_hash TEXT NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memory_capture_exclusions (
 workspace TEXT NOT NULL, native_session_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('held','excluded')),
 revision INTEGER NOT NULL CHECK(revision>0), reason TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace,native_session_id)
);
CREATE TABLE memory_review_states (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id), workspace TEXT NOT NULL,
 session_id TEXT NOT NULL, source_generation TEXT NOT NULL,
 admitted_after_seq INTEGER NOT NULL, scanned_through_seq INTEGER NOT NULL,
 scheduled_through_seq INTEGER NOT NULL, reviewed_through_seq INTEGER NOT NULL,
 terminal_outcome TEXT, handoff_run_id TEXT,
 handoff_status TEXT NOT NULL DEFAULT 'none' CHECK(handoff_status IN ('none','finalizer_pending','finalizer_completed','finalizer_failed','no_consumer')),
 lease_nonce TEXT, lease_until TEXT, lease_owner TEXT, reason TEXT,
 UNIQUE(workspace,session_id,run_id,source_generation)
);
-- Native input identities are indexed independently of the bounded job manifest.
CREATE TABLE memory_review_turns (
 run_id TEXT NOT NULL REFERENCES memory_review_states(run_id), session_id TEXT NOT NULL,
 source_generation TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
 input_id TEXT NOT NULL, PRIMARY KEY(run_id,start_seq,input_id),
 UNIQUE(session_id,source_generation,input_id)
);
CREATE INDEX memory_review_turn_range ON memory_review_turns(run_id,end_seq);
CREATE TABLE memory_review_jobs (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES memory_review_states(run_id), source_generation TEXT NOT NULL,
 start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL CHECK(end_seq>=start_seq),
 input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
 settings_generation INTEGER NOT NULL, policy_revision INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('periodic','manual','boundary','retry')),
 retry_parent_id TEXT UNIQUE REFERENCES memory_review_jobs(id),
 state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatched','completed','held','rejected','deferred','cancelled','superseded')),
 owner_nonce TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
 dispatch_day TEXT, dispatched_at TEXT, completed_at TEXT, next_eligible_at TEXT,
 result_json TEXT, usage_json TEXT, duration_ms REAL, request_bytes INTEGER, adoption_wait_ms REAL, reason TEXT,
 resolved_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX memory_review_pending ON memory_review_jobs(workspace,state,created_at);
CREATE INDEX memory_review_budget ON memory_review_jobs(workspace,dispatch_day);
CREATE INDEX memory_review_ranges ON memory_review_jobs(run_id,start_seq,end_seq);
CREATE TABLE memory_review_effects (
 job_id TEXT NOT NULL, operation_index INTEGER NOT NULL,
 workspace TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
 source_generation TEXT NOT NULL, evidence_json TEXT NOT NULL,
 action TEXT NOT NULL, disposition TEXT NOT NULL, reason TEXT,
 entry_id TEXT, revision INTEGER, content_hash TEXT, previous_revision INTEGER,
 content_identity TEXT, source_end_seq INTEGER NOT NULL,
 PRIMARY KEY(job_id,operation_index)
);
-- Deliberately no entry FK: deletion must preserve the source tombstone.
CREATE INDEX memory_review_effect_entry ON memory_review_effects(entry_id,revision);
CREATE INDEX memory_review_effect_run ON memory_review_effects(run_id,source_end_seq);
CREATE INDEX memory_review_effect_content ON memory_review_effects(workspace,content_identity);
CREATE TRIGGER memory_review_input_immutable BEFORE UPDATE OF id,workspace,session_id,run_id,source_generation,start_seq,end_seq,input_json,input_hash,settings_generation,policy_revision,origin,retry_parent_id ON memory_review_jobs
BEGIN SELECT RAISE(ABORT,'memory review input is immutable'); END;
ALTER TABLE dsh_memory_finalizations ADD COLUMN memory_adoption_version INTEGER NOT NULL DEFAULT 1 CHECK(memory_adoption_version IN (1,2));
ALTER TABLE dsh_memory_finalizations ADD COLUMN capture_admission TEXT NOT NULL DEFAULT 'ready' CHECK(capture_admission IN ('ready','excluded','held'));
ALTER TABLE dsh_memory_finalizations ADD COLUMN claim_nonce TEXT;
ALTER TABLE dsh_memory_finalizations ADD COLUMN lease_until TEXT;
ALTER TABLE dsh_memory_finalizations ADD COLUMN dispatched_at TEXT;
CREATE TRIGGER memory_adoption_version_immutable BEFORE UPDATE OF memory_adoption_version ON dsh_memory_finalizations
WHEN OLD.memory_adoption_version<>NEW.memory_adoption_version
BEGIN SELECT RAISE(ABORT,'memory adoption version is immutable'); END;
