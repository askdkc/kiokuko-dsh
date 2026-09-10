-- Existing deliveries and pending jobs retain their historical representation.
ALTER TABLE context_delivery_entries ADD COLUMN projection_json TEXT;
ALTER TABLE dsh_memory_finalizations ADD COLUMN evidence_selection_version INTEGER NOT NULL DEFAULT 1
  CHECK (evidence_selection_version IN (1, 2));
CREATE TRIGGER dsh_finalization_evidence_selection_immutable
BEFORE UPDATE OF evidence_selection_version ON dsh_memory_finalizations
WHEN NEW.evidence_selection_version <> OLD.evidence_selection_version
BEGIN SELECT RAISE(ABORT, 'finalization evidence selection version is immutable'); END;
CREATE TRIGGER context_delivery_projection_immutable
BEFORE UPDATE OF projection_json ON context_delivery_entries
WHEN NEW.projection_json IS NOT OLD.projection_json
BEGIN SELECT RAISE(ABORT, 'context delivery projection is immutable'); END;
CREATE TABLE context_delivery_omissions (
  delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  reason TEXT NOT NULL CHECK (reason IN ('budget','limit','diversified','secret')),
  PRIMARY KEY (delivery_id, entry_id)
);
CREATE TRIGGER context_delivery_omissions_immutable BEFORE UPDATE ON context_delivery_omissions
BEGIN SELECT RAISE(ABORT, 'context delivery omissions are immutable'); END;
