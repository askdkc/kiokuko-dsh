-- Each work-report attempt is distinct; replay within an attempt remains idempotent.
ALTER TABLE dsh_turn_intents ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0);
ALTER TABLE dsh_turn_receipts ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0);
UPDATE dsh_turn_receipts AS receipt SET execution_attempt = (
  SELECT COUNT(*) FROM dsh_turn_receipts AS prior
  WHERE prior.run_id = receipt.run_id AND prior.phase = 'work_unit'
    AND prior.work_unit_key = receipt.work_unit_key AND prior.contract_revision = receipt.contract_revision
    AND prior.outcome_kind = 'applied' AND prior.native_turn < receipt.native_turn
) WHERE receipt.phase = 'work_unit';
UPDATE dsh_turn_intents SET execution_attempt = COALESCE(
  (SELECT execution_attempt FROM dsh_turn_receipts WHERE receipt_id = dsh_turn_intents.receipt_id), 0);
DROP INDEX idx_dsh_turn_receipts_applied_identity;
CREATE UNIQUE INDEX idx_dsh_turn_receipts_applied_identity
  ON dsh_turn_receipts(run_id, phase, contract_revision, work_unit_key, execution_attempt, input_digest)
  WHERE outcome_kind = 'applied';
DROP TRIGGER dsh_turn_receipt_from_enno_completion;
CREATE TRIGGER dsh_turn_receipt_from_enno_completion
AFTER UPDATE OF state, response_json ON enno_operation_receipts
WHEN NEW.state = 'completed' AND OLD.state <> 'completed'
  AND EXISTS (
      SELECT 1 FROM dsh_turn_intents AS intent
       WHERE intent.run_id = NEW.run_id
         AND intent.operation = NEW.operation
         AND intent.idempotency_key = NEW.idempotency_key
  )
BEGIN
    INSERT INTO dsh_turn_receipts (
        receipt_id, run_id, dsh_session_id, native_turn, phase,
        contract_revision, work_unit_key, input_digest, execution_attempt, outcome_kind,
        next_action, enno_operation, enno_idempotency_key, created_at
    )
    SELECT intent.receipt_id, intent.run_id, intent.dsh_session_id,
           intent.native_turn, intent.phase, intent.contract_revision,
           intent.work_unit_key, intent.input_digest, intent.execution_attempt, 'applied',
           json_extract(NEW.response_json, '$.ennoOduno.nextAction'),
           NEW.operation, NEW.idempotency_key, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_turn_handoffs (receipt_id, handoff_json, created_at)
    SELECT intent.receipt_id,
           json_object(
               'schemaVersion', 1,
               'runId', intent.run_id,
               'phase', intent.phase,
               'revision', intent.contract_revision,
               'nextAction', json_extract(NEW.response_json, '$.ennoOduno.nextAction'),
               'source', 'enno_operation_receipt'
           ),
           NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_boundary_jobs (
        job_id, receipt_id, run_id, kind, status, available_at,
        created_at, updated_at
    )
    SELECT intent.boundary_job_id,
           intent.receipt_id, intent.run_id,
           'classify_boundary',
           'pending', NEW.finished_at, NEW.finished_at, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;

    INSERT INTO dsh_continuation_outbox (
        continuation_id, receipt_id, run_id, dsh_session_id,
        causal_revision, message_json, status, created_at, updated_at
    )
    SELECT intent.continuation_id, intent.receipt_id, intent.run_id,
           intent.dsh_session_id, intent.contract_revision,
           json_object(
               'id', intent.continuation_id,
               'role', 'user',
               'content', json_array(json_object(
                   'type', 'text',
                   'text', 'Continue Kiokuko processing from nextAction: ' ||
                       coalesce(json_extract(NEW.response_json, '$.ennoOduno.nextAction'), 'complete')
               )),
               'source', json_object(
                   'kind', 'plugin', 'plugin', 'kiokuko-dsh',
                   'form', 'continuation', 'deliveryId', intent.continuation_id
               )
           ),
           CASE WHEN json_extract(NEW.response_json, '$.ennoOduno.nextAction') IN ('complete', 'report_blocker')
                THEN 'superseded' ELSE 'pending' END,
           NEW.finished_at, NEW.finished_at
      FROM dsh_turn_intents AS intent
     WHERE intent.run_id = NEW.run_id
       AND intent.operation = NEW.operation
       AND intent.idempotency_key = NEW.idempotency_key;
END;

CREATE TABLE dsh_completion_reports (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES dsh_turn_receipts(receipt_id),
  dsh_session_id TEXT NOT NULL,
  native_turn INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  delivered_seq INTEGER,
  CHECK (delivered_seq IS NULL OR delivered_seq >= 0)
);
CREATE TRIGGER dsh_completion_report_pending AFTER INSERT ON dsh_turn_receipts
WHEN NEW.outcome_kind = 'applied' AND NEW.next_action IN ('complete', 'report_blocker')
BEGIN
  INSERT OR IGNORE INTO dsh_completion_reports(run_id, receipt_id, dsh_session_id, native_turn)
  VALUES (NEW.run_id, NEW.receipt_id, NEW.dsh_session_id, NEW.native_turn);
END;
-- Recover a completion interrupted before the plugin upgrade without replaying old closed runs.
INSERT OR IGNORE INTO dsh_completion_reports(run_id, receipt_id, dsh_session_id, native_turn)
SELECT receipt.run_id, receipt.receipt_id, receipt.dsh_session_id, receipt.native_turn
FROM dsh_turn_receipts AS receipt JOIN ledger_runs AS run ON run.run_id = receipt.run_id
WHERE receipt.next_action IN ('complete', 'report_blocker') AND run.status = 'active';
