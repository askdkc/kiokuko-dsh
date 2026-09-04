# DSH execution ledger

The ledger records one DSH run, its Akinator intake, ordered lifecycle events,
evidence, context deliveries, and feedback. Every `ledger_runs` row carries its
authoritative `dsh_session_id`; the schema baseline has no client-kind column.

DSH session rebinding emits `enno.dsh_session_bound` or
`enno.dsh_session_rebound` with
only the previous and next DSH session IDs. The route epoch increments at the
same mutation. A current WorkUnit lease prevents rebinding; an expired lease may
be replaced atomically by the new session.

Kiokuko's event chain remains hashed and sequence-ordered for Kiokuko domain
events. It deliberately does not duplicate the DSH session log into
`ledger_events`: DSH already owns the lossless append-only record, and a second
bounded payload path can corrupt completion and export semantics.

Admission records the run's exact DSH `turn/start` sequence in
`dsh_run_log_boundaries`. On successful terminal close, after the matching
native `turn/end` has been checkpointed, one SQLite transaction marks
`ledger_runs` completed and inserts `dsh_memory_finalizations` with the
immutable inclusive start/end range. A background worker reads the exact
live-or-persisted DSH session by ID but ignores every later event. Success
writes self-contained memory entries plus `dsh_memory_finalization_entries`;
failure updates only the retryable job. The completed run is never rolled back
because an auxiliary model, session query, validation, or secret check failed.
Range-bound log and capsule SHA-256 digests, event count, provider/model, and
cache/input/output token counts provide bounded provenance without copying the
raw log.
