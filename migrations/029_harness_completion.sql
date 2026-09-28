-- NULL means an older verifier result with unobserved test coverage.
ALTER TABLE enno_verifier_runs
  ADD COLUMN skipped INTEGER CHECK (skipped IS NULL OR skipped IN (0, 1));
ALTER TABLE enno_verifier_runs ADD COLUMN tap_summary_json TEXT CHECK (tap_summary_json IS NULL OR json_valid(tap_summary_json));

CREATE TABLE dsh_completion_runs (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  created_at TEXT NOT NULL
);
CREATE TABLE dsh_completion_bindings (
  run_id TEXT NOT NULL REFERENCES dsh_completion_runs(run_id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  criterion_revision INTEGER NOT NULL,
  method_json TEXT NOT NULL CHECK (json_valid(method_json)),
  method_digest TEXT NOT NULL,
  approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, criterion_id)
);
CREATE TABLE dsh_completion_bind_ops (
  run_id TEXT NOT NULL REFERENCES dsh_completion_runs(run_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  PRIMARY KEY (run_id, call_id)
);
CREATE TABLE dsh_completion_executions (
  run_id TEXT NOT NULL REFERENCES dsh_completion_runs(run_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  method_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'passed', 'failed', 'unknown', 'stale')),
  exit_code INTEGER,
  tap_summary_json TEXT CHECK (tap_summary_json IS NULL OR json_valid(tap_summary_json)),
  result_digest TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, call_id)
);
CREATE INDEX idx_dsh_completion_executions_method ON dsh_completion_executions(run_id, method_digest, updated_at DESC);
CREATE TABLE dsh_completion_receipts (
  run_id TEXT PRIMARY KEY REFERENCES dsh_completion_runs(run_id) ON DELETE CASCADE,
  assessment_json TEXT NOT NULL CHECK (json_valid(assessment_json)),
  updated_at TEXT NOT NULL
);
