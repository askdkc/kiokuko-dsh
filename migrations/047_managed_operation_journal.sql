-- Separate from owned execution: covers only plugin-observed managed boundaries.
CREATE TABLE dsh_managed_journal_keys (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
CREATE TABLE dsh_managed_scopes (
 scope_id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, sealed INTEGER NOT NULL DEFAULT 0,
 collector_complete INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE dsh_managed_operations (
 operation_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES dsh_managed_scopes(scope_id),
 sequence INTEGER NOT NULL, state TEXT NOT NULL, operation_json TEXT NOT NULL,
 UNIQUE(scope_id,sequence)
);
CREATE TABLE dsh_managed_transitions (
 operation_id TEXT NOT NULL REFERENCES dsh_managed_operations(operation_id),
 sequence INTEGER NOT NULL, transition_json TEXT NOT NULL, PRIMARY KEY(operation_id,sequence)
);
CREATE TABLE dsh_managed_snapshots (
 snapshot_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES dsh_managed_scopes(scope_id),
 snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX dsh_managed_operations_scope ON dsh_managed_operations(scope_id);
CREATE UNIQUE INDEX dsh_managed_operations_original ON dsh_managed_operations(json_extract(operation_json,'$.originalRef')) WHERE json_extract(operation_json,'$.originalRef') IS NOT NULL;
