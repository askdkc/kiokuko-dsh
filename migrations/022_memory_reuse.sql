-- Preserve historical omissions and their foreign keys; add one diagnostic reason.
DROP TRIGGER context_delivery_omissions_immutable;
ALTER TABLE context_delivery_omissions RENAME TO context_delivery_omissions_previous;
CREATE TABLE context_delivery_omissions (
  delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  reason TEXT NOT NULL CHECK (reason IN ('budget','limit','diversified','secret','semantic_not_applicable')),
  PRIMARY KEY (delivery_id, entry_id)
);
INSERT INTO context_delivery_omissions SELECT * FROM context_delivery_omissions_previous;
DROP TABLE context_delivery_omissions_previous;
CREATE TRIGGER context_delivery_omissions_immutable BEFORE UPDATE ON context_delivery_omissions
BEGIN SELECT RAISE(ABORT, 'context delivery omissions are immutable'); END;
