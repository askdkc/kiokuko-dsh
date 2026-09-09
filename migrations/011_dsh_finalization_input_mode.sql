-- Freeze the requested extraction strategy across retry/reload. Existing jobs keep their old request.
ALTER TABLE dsh_memory_finalizations ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'prefix_reuse'
    CHECK (input_mode IN ('prefix_reuse', 'bounded_evidence'));

CREATE TRIGGER dsh_memory_finalizations_input_mode_guard
BEFORE UPDATE OF input_mode ON dsh_memory_finalizations
WHEN NEW.input_mode <> OLD.input_mode
BEGIN
    SELECT RAISE(ABORT, 'memory finalization input mode is immutable');
END;
