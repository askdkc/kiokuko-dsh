-- Optional observation index. The existing run ledger and session mirror remain intact.
CREATE TABLE dsh_orca_traces (
  orca_run_id TEXT PRIMARY KEY,
  dsh_session_id TEXT NOT NULL,
  recorder_instance_id TEXT NOT NULL,
  recording_generation TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  store_root TEXT NOT NULL,
  session_cwd TEXT NOT NULL,
  capture_format_version INTEGER NOT NULL CHECK (capture_format_version = 1),
  state TEXT NOT NULL CHECK (state IN ('starting','recording','finalizing','completed','incomplete','failed')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_error_code TEXT,
  missing_event_count INTEGER NOT NULL DEFAULT 0,
  unresolved_call_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  recorded_bytes INTEGER NOT NULL DEFAULT 0,
  export_input_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE(recorder_instance_id, dsh_session_id, recording_generation)
);
CREATE INDEX dsh_orca_session_traces ON dsh_orca_traces(dsh_session_id, workspace_key, started_at DESC);
CREATE TABLE dsh_orca_trace_run_links (
  orca_run_id TEXT NOT NULL REFERENCES dsh_orca_traces(orca_run_id) ON DELETE CASCADE,
  -- Historical association survives logical-run pruning.
  kiokuko_run_id TEXT NOT NULL,
  PRIMARY KEY(orca_run_id, kiokuko_run_id)
);
