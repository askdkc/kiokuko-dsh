CREATE TABLE dsh_lisp_sessions (
  session_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  epoch TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE dsh_lisp_operations (
  session_id TEXT NOT NULL REFERENCES dsh_lisp_sessions(session_id),
  agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, agent_id, operation_id)
);
CREATE INDEX dsh_lisp_pending ON dsh_lisp_operations(session_id,state);
