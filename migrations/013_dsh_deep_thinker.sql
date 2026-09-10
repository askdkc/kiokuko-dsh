-- Deep owns its problem graph and authority; Enno records retain their contracts.
CREATE TABLE dsh_execution_owners (
  dsh_session_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('normal','enno','deep-thinker')),
  start_id TEXT NOT NULL,
  run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dsh_execution_owner_run ON dsh_execution_owners(run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER dsh_execution_owner_release AFTER UPDATE OF status ON ledger_runs
WHEN NEW.status IN ('completed','failed','cancelled','interrupted')
BEGIN DELETE FROM dsh_execution_owners WHERE run_id=NEW.run_id; END;

CREATE TABLE dsh_deep_intents (
  start_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, dsh_session_id TEXT NOT NULL,
  command_id TEXT NOT NULL, command_digest TEXT NOT NULL, message_id TEXT NOT NULL, input_digest TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)), revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('armed','pending','accepted','paused','cancelled','completed')),
  run_id TEXT REFERENCES ledger_runs(run_id), created_at INTEGER NOT NULL,
  UNIQUE(dsh_session_id,command_id), UNIQUE(dsh_session_id,message_id)
);
CREATE UNIQUE INDEX dsh_deep_active_intent ON dsh_deep_intents(dsh_session_id)
  WHERE status IN ('armed','pending','accepted','paused');
CREATE TABLE dsh_deep_preferences (
  workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
  configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json))
);
CREATE TABLE dsh_deep_runs (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id), start_id TEXT NOT NULL UNIQUE REFERENCES dsh_deep_intents(start_id),
  workspace TEXT NOT NULL, dsh_session_id TEXT NOT NULL, phase TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  UNIQUE(run_id,workspace,dsh_session_id)
);
CREATE TABLE dsh_deep_nodes (
  run_id TEXT NOT NULL REFERENCES dsh_deep_runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY(run_id,node_id)
);
CREATE TABLE dsh_deep_edges (
  run_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('child','dependency')),
  PRIMARY KEY(run_id,source_id,target_id,kind),
  FOREIGN KEY(run_id,source_id) REFERENCES dsh_deep_nodes(run_id,node_id),
  FOREIGN KEY(run_id,target_id) REFERENCES dsh_deep_nodes(run_id,node_id), CHECK(source_id<>target_id)
);
CREATE TABLE dsh_deep_attempts (
  attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  node_revision INTEGER NOT NULL, requirement_revision INTEGER NOT NULL,
  owner_epoch INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('planner','solver','critic','synthesizer')),
  input_digest TEXT NOT NULL, prompt TEXT NOT NULL, model_json TEXT NOT NULL CHECK(json_valid(model_json)), child_session_id TEXT UNIQUE,
  input_artifact_ids_json TEXT NOT NULL DEFAULT '[]', repair_of TEXT REFERENCES dsh_deep_attempts(attempt_id),
  status TEXT NOT NULL CHECK(status IN ('reserved','started','completed','failed','uncertain','cancelled','abandoned')),
  result_json TEXT, created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id,node_id) REFERENCES dsh_deep_nodes(run_id,node_id)
);
CREATE INDEX dsh_deep_attempts_run ON dsh_deep_attempts(run_id,status);
CREATE TABLE dsh_deep_artifacts (
  artifact_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)), PRIMARY KEY(run_id,artifact_id),
  FOREIGN KEY(run_id,node_id) REFERENCES dsh_deep_nodes(run_id,node_id)
);
CREATE TABLE dsh_deep_evidence (
  run_id TEXT NOT NULL, node_id TEXT NOT NULL, node_revision INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(run_id,node_id,node_revision), FOREIGN KEY(run_id,node_id) REFERENCES dsh_deep_nodes(run_id,node_id)
);
CREATE TABLE dsh_deep_budget_reservations (
  reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES dsh_deep_runs(run_id),
  attempt_id TEXT REFERENCES dsh_deep_attempts(attempt_id), tokens INTEGER NOT NULL CHECK(tokens>=0),
  status TEXT NOT NULL CHECK(status IN ('reserved','settled','uncertain')), actual_tokens INTEGER,
  created_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('agent','memory'))
);
CREATE INDEX dsh_deep_budget_run ON dsh_deep_budget_reservations(run_id,status);
CREATE TABLE dsh_deep_outbox (
  event_id TEXT PRIMARY KEY, start_id TEXT NOT NULL REFERENCES dsh_deep_intents(start_id),
  run_id TEXT REFERENCES dsh_deep_runs(run_id), dsh_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('input','status','report')), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','delivered')), event_seq INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX dsh_deep_outbox_pending ON dsh_deep_outbox(dsh_session_id,status,created_at);
-- Deep input is bound to its report, not a fabricated parent model turn.
CREATE TABLE dsh_deep_finalizations (
  run_id TEXT PRIMARY KEY REFERENCES dsh_deep_runs(run_id), source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed','uncertain','skipped')),
  reservation_id TEXT REFERENCES dsh_deep_budget_reservations(reservation_id),
  process_id TEXT, lease_until INTEGER,
  entry_id TEXT REFERENCES entries(id), error TEXT
);
