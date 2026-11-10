-- Separate delivery progress from the existing question ownership claim.
-- Legacy reservations have unknown delivery; do not promote them on upgrade.
ALTER TABLE dsh_clarification_claims ADD COLUMN delivery_phase TEXT NOT NULL
  DEFAULT 'unknown' CHECK(delivery_phase IN ('unknown','waiting','queued','captured','consumed'));
ALTER TABLE dsh_clarification_claims ADD COLUMN answer_context_json TEXT;
ALTER TABLE dsh_clarification_claims ADD COLUMN answer_content_digest TEXT;
