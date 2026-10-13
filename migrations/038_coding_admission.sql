-- Admission intent is run-bound. Existing runs remain on the explicit legacy
-- path; every run created after this migration must write its own admission.
CREATE TABLE dsh_coding_admissions (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  request_id TEXT,
  request_digest TEXT,
  admission_version TEXT NOT NULL,
  intent_policy_version TEXT NOT NULL,
  change_scope TEXT NOT NULL CHECK(change_scope IN ('implementation','document','unknown')),
  confirmation_required INTEGER NOT NULL CHECK(confirmation_required IN (0,1)),
  legacy INTEGER NOT NULL CHECK(legacy IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK((legacy=1 AND admission_version='legacy' AND confirmation_required=0)
    OR (legacy=0 AND request_id IS NOT NULL AND request_digest IS NOT NULL
      AND admission_version='lisp-choice-admission-v1'))
);
INSERT INTO dsh_coding_admissions
  (run_id,request_id,request_digest,admission_version,intent_policy_version,change_scope,confirmation_required,legacy,created_at)
SELECT run_id,NULL,NULL,'legacy','legacy','unknown',0,1,created_at FROM ledger_runs;
