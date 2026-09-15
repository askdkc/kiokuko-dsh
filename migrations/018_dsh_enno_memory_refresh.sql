CREATE TABLE dsh_enno_memory_refresh (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    request_generation INTEGER NOT NULL DEFAULT 0 CHECK (request_generation >= 0),
    full_search_count INTEGER NOT NULL DEFAULT 0 CHECK (full_search_count >= 0),
    latest_focus_digest TEXT,
    config_digest TEXT NOT NULL,
    last_applied_query_digest TEXT,
    last_selected_set_digest TEXT,
    last_delivery_id TEXT,
    updated_at TEXT NOT NULL
);
