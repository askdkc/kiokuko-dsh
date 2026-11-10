-- Legacy reservations have an uncertain delivery outcome and must not be replayed.
ALTER TABLE dsh_loop_guard_claims ADD COLUMN verification_delivery_phase TEXT NOT NULL DEFAULT 'unknown'
  CHECK (verification_delivery_phase IN ('unknown','reserved','dispatching','dispatched','observed'));
