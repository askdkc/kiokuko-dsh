-- Host-owned identity for typed completion evidence. Legacy command evidence
-- remains readable, but is never promoted into this contract.
ALTER TABLE dsh_completion_executions ADD COLUMN criterion_id TEXT;
ALTER TABLE dsh_completion_executions ADD COLUMN criterion_revision INTEGER;
ALTER TABLE dsh_completion_executions ADD COLUMN operation_spec_digest TEXT;
ALTER TABLE dsh_completion_executions ADD COLUMN owner_session_id TEXT;
ALTER TABLE dsh_completion_executions ADD COLUMN owner_agent_id TEXT;
ALTER TABLE dsh_completion_executions ADD COLUMN environment_digest TEXT;
ALTER TABLE dsh_completion_executions ADD COLUMN evidence_version INTEGER;
ALTER TABLE dsh_completion_executions ADD COLUMN persistence_state TEXT
  CHECK(persistence_state IS NULL OR persistence_state IN ('saved','pending','failed'));

CREATE INDEX idx_dsh_completion_typed_evidence
  ON dsh_completion_executions(run_id, criterion_id, criterion_revision, operation_spec_digest, updated_at DESC);
