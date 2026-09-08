-- Recording preferences survive host reloads and are scoped to an exact session/store.
CREATE TABLE dsh_orca_session_choices (
  dsh_session_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  session_cwd TEXT NOT NULL,
  store_root TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dsh_session_id, workspace_root, session_cwd, store_root)
);
