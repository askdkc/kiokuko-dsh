# DSH execution ledger

The ledger records one DSH run, its Akinator intake, ordered lifecycle events,
evidence, context deliveries, and feedback. `ledger_runs.client_kind` remains in
the historical schema but migration 024 and its guards permit only `dsh` rows.

DSH session rebinding emits `enno.dsh_session_bound` or
`enno.dsh_session_rebound` with
only the previous and next DSH session IDs. The route epoch increments at the
same mutation. A current WorkUnit lease prevents rebinding; an expired lease may
be replaced atomically by the new session.

Every event chain is hashed and sequence-ordered. Session bridge writes are
queued with bounded capacity, exact source identity, replay deduplication, and a
durability barrier before terminal run close.
