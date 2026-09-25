CREATE TABLE dsh_model_auto_sessions (
 session_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','observe','auto')),
 config_digest TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, manual_seq INTEGER, pin_json TEXT,
 last_json TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE dsh_model_auto_routes (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id), session_id TEXT NOT NULL,
 request_id TEXT NOT NULL, native_turn INTEGER NOT NULL, input_digest TEXT NOT NULL,
 policy_version TEXT NOT NULL, config_digest TEXT NOT NULL, catalog_digest TEXT NOT NULL,
 session_revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('deciding','selected','retained','cancelled')),
 baseline_json TEXT, binding_json TEXT, reason TEXT NOT NULL,
 elapsed_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
