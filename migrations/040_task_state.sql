-- The ledger run is the task. These columns do not replace execution outcomes.
ALTER TABLE ledger_runs ADD COLUMN task_state TEXT NOT NULL DEFAULT 'ToDo'
  CHECK(task_state IN ('ToDo','Working','Pending','Done','Ignore'));
ALTER TABLE ledger_runs ADD COLUMN task_revision INTEGER NOT NULL DEFAULT 1 CHECK(task_revision > 0);
ALTER TABLE ledger_runs ADD COLUMN task_generation INTEGER NOT NULL DEFAULT 1 CHECK(task_generation > 0);
ALTER TABLE ledger_runs ADD COLUMN task_repository_root TEXT;
ALTER TABLE ledger_runs ADD COLUMN task_owner_session_id TEXT;
ALTER TABLE ledger_runs ADD COLUMN task_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger_runs ADD COLUMN task_evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(task_evidence_json));
ALTER TABLE ledger_runs ADD COLUMN task_resumed INTEGER NOT NULL DEFAULT 0 CHECK(task_resumed IN (0,1));
ALTER TABLE ledger_runs ADD COLUMN task_managed INTEGER NOT NULL DEFAULT 0 CHECK(task_managed IN (0,1));
ALTER TABLE ledger_runs ADD COLUMN task_pending_stop_json TEXT CHECK(task_pending_stop_json IS NULL OR json_valid(task_pending_stop_json));
ALTER TABLE ledger_runs ADD COLUMN task_unresolved_json TEXT CHECK(task_unresolved_json IS NULL OR json_valid(task_unresolved_json));
ALTER TABLE ledger_runs ADD COLUMN task_previous_outcome_json TEXT CHECK(task_previous_outcome_json IS NULL OR json_valid(task_previous_outcome_json));
UPDATE ledger_runs SET task_state=CASE status WHEN 'active' THEN 'Working' WHEN 'completed' THEN 'Done'
  WHEN 'failed' THEN 'Pending' WHEN 'cancelled' THEN 'Pending' WHEN 'interrupted' THEN 'Pending' ELSE 'ToDo' END,
  task_repository_root=COALESCE((SELECT repository_root FROM dsh_coding_workflows WHERE run_id=ledger_runs.run_id),
    (SELECT repository_root FROM enno_contracts WHERE run_id=ledger_runs.run_id));

-- Evidence is host-observed provenance, never a second task-state store.
CREATE TABLE ledger_task_evidence (
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  evidence_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  kind TEXT NOT NULL CHECK(kind IN ('verification','stopped')),
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  PRIMARY KEY(run_id,evidence_ref)
);
CREATE TRIGGER ledger_task_execution_outcome AFTER UPDATE OF status ON ledger_runs
WHEN NEW.status <> OLD.status AND NEW.task_revision=OLD.task_revision
BEGIN
  UPDATE ledger_runs SET task_state=CASE
    WHEN task_pending_stop_json IS NOT NULL THEN task_state
    WHEN task_state IN ('Done','Ignore') THEN task_state
    WHEN NEW.status IN ('completed','failed','cancelled','interrupted') THEN 'Pending'
    WHEN NEW.status='active' AND task_managed=0 AND COALESCE(json_extract(metadata_json,'$.taskStateExplicit'),0)<>1 THEN 'Working'
    ELSE task_state END,
    task_revision=task_revision+1,task_generation=task_generation+1,task_resumed=0
    WHERE run_id=NEW.run_id;
END;
CREATE TRIGGER ledger_task_terminal_owner_release AFTER UPDATE OF task_state ON ledger_runs
WHEN NEW.task_state IN ('Done','Ignore')
BEGIN DELETE FROM dsh_execution_owners WHERE run_id=NEW.run_id; END;
CREATE INDEX idx_ledger_task_session_state ON ledger_runs(dsh_session_id,task_state,updated_at);
