CREATE TABLE memory_forget_tombstones (
 entry_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, revision INTEGER NOT NULL,
 hashes_json TEXT NOT NULL, sources_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE memory_forget_receipts (
 operation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, entry_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL, result_json TEXT NOT NULL
);
-- Erasure is the only exception to immutable revision payloads. Identities remain immutable.
DROP TRIGGER entry_revisions_immutable_update;
CREATE TRIGGER entry_revisions_immutable_update BEFORE UPDATE ON entry_revisions
WHEN NOT (EXISTS(SELECT 1 FROM memory_forget_tombstones WHERE entry_id=OLD.entry_id)
 AND NEW.entry_id=OLD.entry_id AND NEW.revision=OLD.revision AND NEW.workspace=OLD.workspace
 AND NEW.kind=OLD.kind AND NEW.created_by=OLD.created_by AND NEW.created_at=OLD.created_at
 AND NEW.title='[forgotten]' AND NEW.body='[forgotten]' AND NEW.summary IS NULL
 AND NEW.scope_json='{}' AND json_extract(NEW.provenance_json,'$.type')='forgotten'
 AND json_extract(NEW.provenance_json,'$.reference')=OLD.entry_id||':'||OLD.revision)
BEGIN SELECT RAISE(ABORT,'entry_revisions are immutable'); END;
CREATE TABLE memory_forget_jobs(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));
DROP TRIGGER memory_review_input_immutable;
CREATE TRIGGER memory_review_input_immutable BEFORE UPDATE OF id,workspace,session_id,run_id,source_generation,start_seq,end_seq,input_json,input_hash,settings_generation,policy_revision,origin,retry_parent_id ON memory_review_jobs
WHEN NOT (EXISTS(SELECT 1 FROM memory_forget_jobs WHERE kind='review' AND id=OLD.id)
 AND NEW.id=OLD.id AND NEW.workspace=OLD.workspace AND NEW.session_id=OLD.session_id AND NEW.run_id=OLD.run_id
 AND NEW.source_generation=OLD.source_generation AND NEW.start_seq=OLD.start_seq AND NEW.end_seq=OLD.end_seq
 AND NEW.input_hash=OLD.input_hash AND NEW.settings_generation=OLD.settings_generation AND NEW.policy_revision=OLD.policy_revision
 AND NEW.origin=OLD.origin AND NEW.retry_parent_id IS OLD.retry_parent_id AND NEW.input_json='{}')
BEGIN SELECT RAISE(ABORT,'memory review input is immutable'); END;
DROP TRIGGER memory_index_job_immutable;
CREATE TRIGGER memory_index_job_immutable BEFORE UPDATE OF id,workspace,input_json,input_digest,model_json ON memory_index_jobs
WHEN NOT (EXISTS(SELECT 1 FROM memory_forget_jobs WHERE kind='index' AND id=OLD.id)
 AND NEW.id=OLD.id AND NEW.workspace=OLD.workspace AND NEW.input_digest=OLD.input_digest AND NEW.model_json=OLD.model_json AND NEW.input_json='{}')
BEGIN SELECT RAISE(ABORT,'index job input is immutable'); END;
DROP TRIGGER memory_index_peers_immutable;
CREATE TRIGGER memory_index_peers_immutable BEFORE UPDATE OF peers_json,peers_digest ON memory_index_jobs
WHEN OLD.peers_digest IS NOT NULL AND NOT(EXISTS(SELECT 1 FROM memory_forget_jobs WHERE kind='index' AND id=OLD.id) AND NEW.peers_json='[]' AND NEW.peers_digest IS NULL)
BEGIN SELECT RAISE(ABORT,'index peer snapshot is immutable'); END;
DROP TRIGGER memory_evolution_job_input_immutable;
CREATE TRIGGER memory_evolution_job_input_immutable BEFORE UPDATE OF id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm ON memory_evolution_jobs
WHEN NOT(EXISTS(SELECT 1 FROM memory_forget_jobs WHERE kind='evolution' AND id=OLD.id)
 AND NEW.id=OLD.id AND NEW.workspace=OLD.workspace AND NEW.trigger_run=OLD.trigger_run AND NEW.signature=OLD.signature
 AND NEW.kind=OLD.kind AND NEW.input_digest=OLD.input_digest AND NEW.model_json=OLD.model_json AND NEW.algorithm=OLD.algorithm
 AND NEW.input_json='[]' AND NEW.seen_json='[]')
BEGIN SELECT RAISE(ABORT,'evolution job input is immutable'); END;
CREATE TABLE memory_forget_deliveries(delivery_id TEXT PRIMARY KEY REFERENCES context_deliveries(delivery_id));
CREATE TRIGGER memory_forget_tombstones_immutable_update BEFORE UPDATE ON memory_forget_tombstones
BEGIN SELECT RAISE(ABORT,'forget tombstones are permanent'); END;
CREATE TRIGGER memory_forget_tombstones_immutable_delete BEFORE DELETE ON memory_forget_tombstones
BEGIN SELECT RAISE(ABORT,'forget tombstones are permanent'); END;
CREATE TRIGGER memory_forget_receipts_immutable BEFORE UPDATE ON memory_forget_receipts
BEGIN SELECT RAISE(ABORT,'forget receipts are immutable'); END;
CREATE INDEX memory_forget_workspace ON memory_forget_tombstones(workspace);
-- Payload-free explanation receipts let request assembly retire previously read tool data.
CREATE TABLE memory_explain_receipts(session_id TEXT NOT NULL,call_id TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_id,call_id));
