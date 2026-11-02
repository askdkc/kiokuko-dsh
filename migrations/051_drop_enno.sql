-- 051_drop_enno.sql
-- The Enno (役小角 / enno-oduno) orchestration feature was removed from the
-- codebase. Its durable tables are dropped here, children first, so existing
-- databases stay valid and openable after this forward-only migration.
-- Shared DSH machinery (ledger_runs, dsh_turn_receipts, dsh_boundary_jobs,
-- dsh_continuation_outbox, dsh_loop_guard_*) is deliberately retained.

DROP TABLE IF EXISTS enno_advisory_contributions;
DROP TABLE IF EXISTS enno_advisory_rounds;
DROP TABLE IF EXISTS enno_execution_leases;
DROP TABLE IF EXISTS enno_resume_tokens;
DROP TABLE IF EXISTS enno_dsh_continuations;
DROP TABLE IF EXISTS enno_operation_receipts;
DROP TABLE IF EXISTS enno_verifier_runs;
DROP TABLE IF EXISTS enno_work_units;
DROP TABLE IF EXISTS enno_plan_drafts;
DROP TABLE IF EXISTS dsh_enno_delegations;
DROP TABLE IF EXISTS dsh_enno_memory_refresh;
DROP TABLE IF EXISTS enno_contracts;
