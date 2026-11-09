-- Explicitly saved Lisp data/definition references. Nothing in this table is
-- evaluated automatically when a worker or host starts.
CREATE TABLE dsh_lisp_saved_state (
  session_id TEXT NOT NULL REFERENCES dsh_lisp_sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 256),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  kind TEXT NOT NULL CHECK(kind IN ('json','definition','result_ref')),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, agent_id, name)
);
CREATE INDEX idx_dsh_lisp_saved_state_updated ON dsh_lisp_saved_state(session_id, updated_at);

-- One durable switch record prevents duplicate fallback after application
-- restart. Host execution evidence remains in its owning journals.
CREATE TABLE dsh_lisp_fallbacks (
  fallback_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dsh_lisp_sessions(session_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','compacted','continued','failed')),
  reason_code TEXT NOT NULL,
  handoff_json TEXT NOT NULL CHECK(json_valid(handoff_json)),
  compaction_json TEXT CHECK(compaction_json IS NULL OR json_valid(compaction_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_dsh_lisp_fallback_active ON dsh_lisp_fallbacks(session_id)
  WHERE state IN ('prepared','compacted','continued');
