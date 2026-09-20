-- Configuration contains credential references only, never resolved credentials.
CREATE TABLE dsh_decision_bindings (
 request_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, config_digest TEXT NOT NULL
);
CREATE TABLE dsh_decision_results (
 request_id TEXT NOT NULL REFERENCES dsh_decision_bindings(request_id), input_digest TEXT NOT NULL,
 result_json TEXT NOT NULL, PRIMARY KEY(request_id,input_digest)
);
CREATE TABLE enno_plan_drafts (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id), contract_revision INTEGER NOT NULL,
 mutation_revision INTEGER NOT NULL, draft_revision INTEGER NOT NULL, candidate_json TEXT NOT NULL,
 draft_digest TEXT NOT NULL, catalog_digest TEXT NOT NULL, catalog_json TEXT NOT NULL, review_digest TEXT,
 backend_json TEXT, status TEXT NOT NULL CHECK(status IN ('reviewing','reviewed','failed','submitted'))
);
