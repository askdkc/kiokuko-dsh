# DSH database

SQLite is process-local state owned by the DSH runtime. Migrations 001–023 are
immutable upgrade history. Migration 024 is the clean boundary to the DSH-only
product.

Migration 024 deletes every run whose `ledger_runs.client_kind` is not `dsh`.
Foreign-key cascades remove its intake, events, evidence, deliveries, feedback,
Enno contract, WorkUnits, receipts, leases, and advisory graph. Purge-audit rows
that point at the deleted graph are removed before the cascade. Akinator
sessions are removed only when no surviving intake owns them. Independent
memory entries remain; run links disappear with the run graph.

The Enno route tables after migration are DSH-specific:

- `enno_contracts.dsh_session_id`
- `enno_dsh_continuations`
- `enno_resume_tokens.dsh_session_id`
- `enno_execution_leases.dsh_session_id`

Triggers reject new or updated ledger runs with any client kind other than
`dsh`. `dsh_intake_idempotency` replaces the generic gateway table. Migration
completion requires an empty `PRAGMA foreign_key_check` result.

Optional semantic retrieval stores rebuildable vectors beside durable memory.
The runtime may continue with lexical retrieval when the optional vector lane
is unavailable; it never converts an unavailable embedding operation into a
successful vector result.
