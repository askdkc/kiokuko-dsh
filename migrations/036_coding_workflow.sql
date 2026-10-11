-- Old sessions remain legacy; enabled Lisp is never migrated into a task choice.
CREATE TABLE dsh_coding_workflows (
  workflow_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  updated_at TEXT NOT NULL,
  UNIQUE(session_id,request_id)
);
CREATE INDEX idx_dsh_coding_session ON dsh_coding_workflows(session_id);
CREATE TABLE dsh_coding_operations (
  workflow_id TEXT NOT NULL REFERENCES dsh_coding_workflows(workflow_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  PRIMARY KEY(workflow_id,call_id)
);
ALTER TABLE dsh_completion_executions ADD COLUMN coding_scope INTEGER;
ALTER TABLE dsh_completion_executions ADD COLUMN coding_goal_ready INTEGER;
ALTER TABLE dsh_completion_executions ADD COLUMN coding_inputs_json TEXT;
ALTER TABLE enno_verifier_runs ADD COLUMN coding_source_paths_json TEXT;
ALTER TABLE enno_verifier_runs ADD COLUMN coding_source_digest TEXT;
ALTER TABLE enno_verifier_runs ADD COLUMN explicit_test_cases INTEGER;
