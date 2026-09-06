-- Keep loop-recovery semantics out of the frozen DSH v0 message source.
ALTER TABLE dsh_continuation_outbox ADD COLUMN message_form TEXT NOT NULL DEFAULT 'continuation'
  CHECK (message_form IN ('continuation', 'loop-recovery'));

-- Pending rows written by older plugin versions must not be delivered with
-- their retired source shape after this migration. Dispatched rows are kept
-- byte-for-byte because their native delivery already happened.
UPDATE dsh_continuation_outbox
   SET message_form = 'loop-recovery',
       message_json = json_set(
         message_json,
         '$.source',
         json_object('kind', 'plugin', 'plugin', 'kiokuko-dsh', 'form', 'instructions')
       )
 WHERE status = 'pending'
   AND json_extract(message_json, '$.source.kind') = 'plugin'
   AND json_extract(message_json, '$.source.plugin') = 'kiokuko-dsh'
   AND json_extract(message_json, '$.source.form') = 'loop-recovery';

UPDATE dsh_continuation_outbox
   SET message_json = json_set(
         message_json,
         '$.source',
         json_object('kind', 'plugin', 'plugin', 'kiokuko-dsh', 'form', 'instructions')
       )
 WHERE status = 'pending'
   AND json_extract(message_json, '$.source.kind') = 'plugin'
   AND json_extract(message_json, '$.source.plugin') = 'kiokuko-dsh'
   AND (
     json_extract(message_json, '$.source.form') = 'continuation'
     OR json_type(message_json, '$.source.deliveryId') IS NOT NULL
   );

-- Migration 005 replaced this trigger with the execution-attempt-aware form;
-- replace it again so existing databases stop creating v0-invalid messages.
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
                   'form', 'instructions'
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
