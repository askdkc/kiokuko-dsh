# DSH execution ledger

The ledger records one DSH run, its Akinator intake, ordered lifecycle events,
evidence, context deliveries, and feedback. Every `ledger_runs` row carries its
authoritative `dsh_session_id`; the schema baseline has no client-kind column.

DSH session rebinding emits `enno.dsh_session_bound` or
`enno.dsh_session_rebound` with
only the previous and next DSH session IDs. The route epoch increments at the
same mutation. A current WorkUnit lease prevents rebinding; an expired lease may
be replaced atomically by the new session.

Every event chain is hashed and sequence-ordered. Session bridge writes are
queued with bounded capacity, exact source identity, replay deduplication, and a
durability barrier before terminal run close.
