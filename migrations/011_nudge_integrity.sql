-- Keep the nudge table compatible with the only policy implemented by this
-- release. Application and archive validation provide the detailed checks;
-- these triggers protect direct SQL writers and updates as well.
CREATE TRIGGER nudge_deliveries_integrity_insert
BEFORE INSERT ON nudge_deliveries
BEGIN
    SELECT RAISE(ABORT, 'invalid nudge delivery')
    WHERE NEW.policy_version <> 'nudges.v1'
       OR NEW.code NOT IN ('SIDE_EFFECT_OUTCOME_UNKNOWN', 'UNRESOLVED_FAILURE', 'VERIFY_AFTER_MUTATION')
       OR NOT (
           (NEW.code = 'SIDE_EFFECT_OUTCOME_UNKNOWN' AND NEW.priority = 2)
           OR (NEW.code = 'UNRESOLVED_FAILURE' AND NEW.priority = 3)
           OR (NEW.code = 'VERIFY_AFTER_MUTATION' AND NEW.priority = 4)
       )
       OR CASE
           WHEN json_valid(NEW.evidence_event_ids_json)
             THEN json_type(NEW.evidence_event_ids_json) = 'array'
               AND json_array_length(NEW.evidence_event_ids_json) <= 16
           ELSE 0
       END = 0
       OR CASE
           WHEN json_valid(NEW.reference_ids_json)
             THEN json_type(NEW.reference_ids_json) = 'array'
               AND json_array_length(NEW.reference_ids_json) <= 16
           ELSE 0
       END = 0;
END;

CREATE TRIGGER nudge_deliveries_integrity_update
BEFORE UPDATE OF policy_version, code, priority, evidence_event_ids_json, reference_ids_json ON nudge_deliveries
BEGIN
    SELECT RAISE(ABORT, 'invalid nudge delivery')
    WHERE NEW.policy_version <> 'nudges.v1'
       OR NEW.code NOT IN ('SIDE_EFFECT_OUTCOME_UNKNOWN', 'UNRESOLVED_FAILURE', 'VERIFY_AFTER_MUTATION')
       OR NOT (
           (NEW.code = 'SIDE_EFFECT_OUTCOME_UNKNOWN' AND NEW.priority = 2)
           OR (NEW.code = 'UNRESOLVED_FAILURE' AND NEW.priority = 3)
           OR (NEW.code = 'VERIFY_AFTER_MUTATION' AND NEW.priority = 4)
       )
       OR CASE
           WHEN json_valid(NEW.evidence_event_ids_json)
             THEN json_type(NEW.evidence_event_ids_json) = 'array'
               AND json_array_length(NEW.evidence_event_ids_json) <= 16
           ELSE 0
       END = 0
       OR CASE
           WHEN json_valid(NEW.reference_ids_json)
             THEN json_type(NEW.reference_ids_json) = 'array'
               AND json_array_length(NEW.reference_ids_json) <= 16
           ELSE 0
       END = 0;
END;
