-- Payload-free quarantine. These rows never grant execution or adopt memory.
CREATE TABLE dsh_auxiliary_recovery (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, native_turn INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('answer-context','intent-assessment')),
 source_digest TEXT NOT NULL, context_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','retry_wait','verified','rejected','stale')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_nonce TEXT, lease_until INTEGER, next_at INTEGER NOT NULL DEFAULT 0,
 last_reason TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX dsh_auxiliary_recovery_session ON dsh_auxiliary_recovery(session_id,native_turn);
