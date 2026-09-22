-- No answer text, tool output, model credentials or generated correction text.
CREATE TABLE dsh_answer_reviews (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
 request_id TEXT NOT NULL, workspace TEXT NOT NULL, dsh_session_id TEXT NOT NULL, native_turn INTEGER NOT NULL,
 answer_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, answer_digest TEXT NOT NULL, input_digest TEXT NOT NULL,
 catalog_digest TEXT NOT NULL, model_json TEXT NOT NULL, policy_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('evaluating','reserved','consumed','closed')),
 reason TEXT, findings_json TEXT NOT NULL DEFAULT '[]', evidence_refs_json TEXT NOT NULL DEFAULT '[]',
 continuation_id TEXT UNIQUE, message_digest TEXT, correction_turn INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
