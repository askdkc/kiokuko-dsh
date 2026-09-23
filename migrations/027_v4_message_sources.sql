-- Pending continuations have not crossed the native delivery boundary. Keep
-- their IDs and text while replacing only the retired source attribution.
UPDATE dsh_continuation_outbox
   SET message_json = json_remove(
         json_set(message_json, '$.source.kind', 'plugin:kiokuko-dsh'),
         '$.source.plugin', '$.source.deliveryId'
       )
 WHERE status = 'pending'
   AND json_extract(message_json, '$.source.kind') = 'plugin'
   AND json_extract(message_json, '$.source.plugin') = 'kiokuko-dsh';

-- Deep input rows are also durable. A sending row is uncertain and is never
-- retried automatically; only an unsent pending row may be normalized.
UPDATE dsh_deep_outbox
   SET payload_json = json_remove(
         json_set(payload_json, '$.message.source.kind', 'plugin:kiokuko-dsh'),
         '$.message.source.plugin'
       )
 WHERE kind = 'input' AND status = 'pending'
   AND json_extract(payload_json, '$.message.source.kind') = 'plugin'
   AND json_extract(payload_json, '$.message.source.plugin') = 'kiokuko-dsh';

-- Migration 007 owns the current completion trigger. Retain its receipt,
-- handoff, boundary and status semantics; change only the new message source.
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
                   'kind', 'plugin:kiokuko-dsh',
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
