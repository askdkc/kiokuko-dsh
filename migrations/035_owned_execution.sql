CREATE TABLE dsh_owned_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','completed','unknown')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dsh_owned_operations_run ON dsh_owned_operations(run_id, generation);
CREATE TABLE memory_execution_links (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES dsh_owned_operations(operation_id),
  PRIMARY KEY(entry_id, revision, operation_id)
);
ALTER TABLE dsh_memory_finalizations ADD COLUMN staged_capsule_json TEXT CHECK(staged_capsule_json IS NULL OR json_valid(staged_capsule_json));
ALTER TABLE dsh_memory_finalizations ADD COLUMN staged_binding_hash TEXT;
