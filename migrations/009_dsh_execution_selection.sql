-- A choice belongs to a logical ledger run, never to the most recent workspace run.
CREATE TABLE dsh_execution_selections (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE dsh_enno_delegations (
  delegation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  input_digest TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT UNIQUE,
  model_json TEXT NOT NULL CHECK (json_valid(model_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  repository_root TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  authority_json TEXT NOT NULL CHECK (json_valid(authority_json)),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'uncertain')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
