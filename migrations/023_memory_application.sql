-- New runs opt in at native admission. Historical runs are not certified.
CREATE TABLE task_memory_bindings (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  delivery_id TEXT REFERENCES context_deliveries(delivery_id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  mode TEXT NOT NULL CHECK(mode IN ('code','plan','none')),
  retrieval TEXT NOT NULL,
  required_json TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_memory_reviews (
  run_id TEXT NOT NULL REFERENCES task_memory_bindings(run_id),
  generation INTEGER NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  entry_revision INTEGER NOT NULL,
  review_revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  review_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  PRIMARY KEY(run_id, generation, entry_id, review_revision),
  UNIQUE(run_id, request_id)
);
CREATE TABLE task_memory_executions (
  run_id TEXT NOT NULL REFERENCES task_memory_bindings(run_id),
  call_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  command_hash TEXT NOT NULL,
  review_hash TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('running','passed','failed','unknown','stale')),
  exit_code INTEGER,
  result_hash TEXT,
  PRIMARY KEY(run_id, call_id)
);
