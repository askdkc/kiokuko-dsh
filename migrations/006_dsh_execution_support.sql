-- Auxiliary execution state never changes Enno revisions, receipts or leases.
CREATE TABLE dsh_execution_frames (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
  frame_json TEXT NOT NULL CHECK(json_valid(frame_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE dsh_exploration_states (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE dsh_execution_evidence (
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id),
  evidence_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(run_id, evidence_id)
);
