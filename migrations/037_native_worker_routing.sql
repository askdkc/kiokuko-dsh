CREATE TABLE dsh_native_worker_routes (
  child_session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
  state TEXT NOT NULL CHECK(state IN ('admitting', 'active', 'revoked')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_dsh_native_worker_routes_parent ON dsh_native_worker_routes(parent_session_id);
