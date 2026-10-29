CREATE TABLE dsh_lisp_session_hosts (
  session_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  host_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK(pid > 0)
);

-- A frozen file change is exclusive across sessions and host processes.
CREATE UNIQUE INDEX dsh_lisp_proposal_target ON dsh_lisp_operations(json_extract(payload,'$.before.path'))
  WHERE kind='proposal' AND state IN ('RUNNING','AWAITING_APPROVAL','APPLYING','UNKNOWN');
