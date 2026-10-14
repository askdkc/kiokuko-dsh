-- Source history is provenance, not another task authority. Current jobs remain run-keyed.
ALTER TABLE dsh_memory_finalizations ADD COLUMN source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0);
ALTER TABLE dsh_memory_finalizations ADD COLUMN source_outcome TEXT CHECK(source_outcome IN ('completed','failed','cancelled','interrupted'));
CREATE TABLE dsh_task_source_history (
 run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 source_epoch INTEGER NOT NULL CHECK(source_epoch>0),
 source_session_id TEXT NOT NULL,
 original_session_id TEXT NOT NULL,
 task_generation INTEGER NOT NULL,
 next_owner_session_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 boundary_json TEXT CHECK(boundary_json IS NULL OR json_valid(boundary_json)),
 finalization_json TEXT CHECK(finalization_json IS NULL OR json_valid(finalization_json)),
 review_state_json TEXT CHECK(review_state_json IS NULL OR json_valid(review_state_json)),
 archived_at TEXT NOT NULL,
 PRIMARY KEY(run_id,source_epoch)
);
CREATE TABLE dsh_task_source_entries (
 run_id TEXT NOT NULL, source_epoch INTEGER NOT NULL,
 entry_id TEXT NOT NULL REFERENCES entries(id), ordinal INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,source_epoch,ordinal), UNIQUE(run_id,source_epoch,entry_id),
 FOREIGN KEY(run_id,source_epoch) REFERENCES dsh_task_source_history(run_id,source_epoch) ON DELETE CASCADE
);
CREATE TRIGGER dsh_task_source_history_immutable BEFORE UPDATE ON dsh_task_source_history
WHEN NOT (
 NEW.run_id=OLD.run_id AND NEW.source_epoch=OLD.source_epoch AND NEW.source_session_id=OLD.source_session_id
 AND NEW.original_session_id=OLD.original_session_id AND NEW.task_generation=OLD.task_generation
 AND NEW.next_owner_session_id=OLD.next_owner_session_id AND NEW.operation_id=OLD.operation_id AND NEW.reason=OLD.reason
 AND NEW.boundary_json IS OLD.boundary_json AND NEW.review_state_json IS OLD.review_state_json AND NEW.archived_at=OLD.archived_at
 AND json_remove(NEW.finalization_json,'$.staged_capsule_json','$.staged_binding_hash') IS json_remove(OLD.finalization_json,'$.staged_capsule_json','$.staged_binding_hash')
 AND json_extract(NEW.finalization_json,'$.staged_capsule_json') IS NULL
 AND json_extract(NEW.finalization_json,'$.staged_binding_hash') IS NULL
 AND EXISTS(SELECT 1 FROM dsh_task_source_entries e JOIN memory_forget_tombstones t ON t.entry_id=e.entry_id WHERE e.run_id=OLD.run_id AND e.source_epoch=OLD.source_epoch)
)
BEGIN SELECT RAISE(ABORT,'task source history is immutable'); END;
CREATE TRIGGER finalizer_source_epoch_immutable BEFORE UPDATE OF source_epoch ON dsh_memory_finalizations
BEGIN SELECT RAISE(ABORT,'finalizer source epoch is immutable'); END;
DROP TRIGGER dsh_run_log_boundaries_run_guard;
CREATE TRIGGER dsh_run_log_boundaries_run_guard BEFORE INSERT ON dsh_run_log_boundaries
BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ledger_runs r WHERE r.run_id=NEW.run_id AND r.workspace=NEW.workspace
 AND COALESCE(r.task_owner_session_id,r.dsh_session_id)=NEW.dsh_session_id AND r.status IN ('intake','active'))
 THEN RAISE(ABORT,'log boundary requires its active DSH run owner') END;
END;
DROP TRIGGER dsh_memory_finalizations_run_guard;
CREATE TRIGGER dsh_memory_finalizations_run_guard BEFORE INSERT ON dsh_memory_finalizations
BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ledger_runs r WHERE r.run_id=NEW.run_id AND r.workspace=NEW.workspace
 AND COALESCE(r.task_owner_session_id,r.dsh_session_id)=NEW.dsh_session_id
 AND (r.status='completed' OR r.status='failed' AND NEW.extraction_version=2
 OR r.task_state IN ('Pending','Ignore') AND NEW.source_outcome IN ('failed','cancelled','interrupted') AND EXISTS(
 SELECT 1 FROM ledger_task_evidence e JOIN json_each(r.task_evidence_json) proof ON proof.value=e.evidence_ref
 WHERE e.run_id=r.run_id AND e.generation=r.task_generation-1 AND e.kind='stopped' AND e.verified=1)
 OR r.task_state='Done' AND NEW.source_outcome='completed' AND EXISTS(
 SELECT 1 FROM ledger_task_evidence e JOIN json_each(r.task_evidence_json) proof ON proof.value=e.evidence_ref
 WHERE e.run_id=r.run_id AND e.generation=r.task_generation-1 AND e.kind='verification' AND e.verified=1)))
 THEN RAISE(ABORT,'memory finalization requires its terminal DSH run owner') END;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM dsh_run_log_boundaries b WHERE b.run_id=NEW.run_id AND b.workspace=NEW.workspace
 AND b.dsh_session_id=NEW.dsh_session_id AND b.source_start_seq=NEW.source_start_seq)
 THEN RAISE(ABORT,'memory finalization requires its bound DSH log start') END;
 SELECT CASE WHEN NEW.source_epoch<>(SELECT COALESCE(MAX(source_epoch),0)+1 FROM dsh_task_source_history WHERE run_id=NEW.run_id)
 THEN RAISE(ABORT,'memory finalization requires its current source epoch') END;
END;

-- Mutable delivery state for a fixed archived source range; the archival snapshot above stays immutable.
CREATE TABLE dsh_task_source_finalizations (
 run_id TEXT NOT NULL, source_epoch INTEGER NOT NULL,
 job_json TEXT NOT NULL CHECK(json_valid(job_json)),
 PRIMARY KEY(run_id,source_epoch),
 FOREIGN KEY(run_id,source_epoch) REFERENCES dsh_task_source_history(run_id,source_epoch) ON DELETE CASCADE,
 CHECK(json_extract(job_json,'$.run_id')=run_id AND json_extract(job_json,'$.source_epoch')=source_epoch)
);

CREATE TRIGGER dsh_task_source_job_identity BEFORE UPDATE ON dsh_task_source_finalizations
WHEN NEW.run_id<>OLD.run_id OR NEW.source_epoch<>OLD.source_epoch
 OR json_extract(NEW.job_json,'$.run_id') IS NOT json_extract(OLD.job_json,'$.run_id')
 OR json_extract(NEW.job_json,'$.source_epoch') IS NOT json_extract(OLD.job_json,'$.source_epoch')
 OR json_extract(NEW.job_json,'$.workspace') IS NOT json_extract(OLD.job_json,'$.workspace')
 OR json_extract(NEW.job_json,'$.dsh_session_id') IS NOT json_extract(OLD.job_json,'$.dsh_session_id')
 OR json_extract(NEW.job_json,'$.source_start_seq') IS NOT json_extract(OLD.job_json,'$.source_start_seq')
 OR json_extract(NEW.job_json,'$.source_end_seq') IS NOT json_extract(OLD.job_json,'$.source_end_seq')
 OR json_extract(NEW.job_json,'$.outcome') IS NOT json_extract(OLD.job_json,'$.outcome')
 OR json_extract(NEW.job_json,'$.source_generation') IS NOT json_extract(OLD.job_json,'$.source_generation')
BEGIN SELECT RAISE(ABORT,'archived finalization source identity is immutable'); END;

CREATE TRIGGER finalizer_source_outcome_immutable BEFORE UPDATE OF source_outcome ON dsh_memory_finalizations
BEGIN SELECT RAISE(ABORT,'finalizer source outcome is immutable'); END;
