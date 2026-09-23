-- Only newly observed, completed applications are eligible. Historical runs are not backfilled.
ALTER TABLE task_memory_bindings ADD COLUMN fingerprint_json TEXT;

CREATE TABLE auto_global_application_receipts (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id),
  root_run_id TEXT NOT NULL REFERENCES ledger_runs(run_id),
  workspace TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id),
  generation INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  review_hash TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  execution_call_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  PRIMARY KEY(entry_id, entry_revision, run_id),
  UNIQUE(entry_id, execution_call_id)
);
CREATE INDEX idx_auto_global_receipts_entry ON auto_global_application_receipts(entry_id, entry_revision, completed_at);

CREATE TABLE auto_global_queue (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  entry_revision INTEGER NOT NULL CHECK (entry_revision > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','completed','held')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entry_id, entry_revision)
);
CREATE INDEX idx_auto_global_queue_pending ON auto_global_queue(state, updated_at, entry_id);

CREATE TABLE auto_global_projections (
  entry_id TEXT NOT NULL REFERENCES entries(id),
  entry_revision INTEGER NOT NULL CHECK(entry_revision > 0),
  algorithm TEXT NOT NULL,
  global_entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id),
  source_content_hash TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','quarantined','replaced')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entry_id, entry_revision, algorithm)
);
