# DSH database

SQLite is process-local state owned by the DSH runtime. `migrations/001_baseline.sql`
is the single immutable schema baseline; a fresh database is created by applying
it once. Future schema evolution appends new numbered migrations after the
baseline, and applied history is protected by the migration framework's
sequence and checksum validation. There is no rollback path (`migrations/down/`
does not exist), and released migration files are never rewritten.

The baseline binds every ledger run to exactly one authoritative DSH session:

- `ledger_runs.dsh_session_id` (no `client_kind`, `client_version`, or
  `source_session_id` columns exist)
- `enno_contracts.dsh_session_id`
- `enno_dsh_continuations`
- `enno_resume_tokens.dsh_session_id`
- `enno_execution_leases.dsh_session_id`

`migrations/004_dsh_loop_guard.sql` adds the durable automatic-continuation
boundary. `dsh_loop_guard_states` stores one progress fingerprint and a maximum
count of three per run/session; `dsh_loop_guard_claims` makes delivery replay
idempotent and records the single user-question claim. The same migration adds
no-progress counters to leased boundary jobs. A fourth unchanged continuation,
or a fourth stateful host effect without Enno progress, enters `waiting_user`
before another model request is dispatched.

`migrations/005_dsh_completion_recovery.sql` separates receipt identity by
authoritative WorkUnit attempt and adds `dsh_completion_reports`. A terminal
receipt creates its pending report in the same commit. Reports are acknowledged
only after the native session is flushed; reload checks the deterministic
report identity before publishing a fallback again.

`dsh_intake_idempotency` is the intake idempotency store for run-open and
intake-answer replays, keyed by DSH-native `dsh.*` scopes. Baseline completion
requires an empty `PRAGMA foreign_key_check` result.

The hybrid search projection is CJK-capable from the baseline:
`entry_search_documents` is the canonical text projection, `entries_fts`
(unicode61) covers word search, and `entries_trigram` (trigram tokenizer)
covers Japanese substring search without word boundaries.

Optional semantic retrieval stores rebuildable vectors beside durable memory.
The runtime may continue with lexical retrieval when the optional vector lane
is unavailable; it never converts an unavailable embedding operation into a
successful vector result.
