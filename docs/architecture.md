# DSH composition architecture

`src/index.ts` is the primary package entrypoint; `./dsh` remains a compatible
alias and `./client` owns the Web surface. Cordis mounts one composition that
owns the intake gate, model-visible tools, durable boundary worker, run ledger,
post-completion DSH-log finalizer, memory retrieval, optional embedding worker,
and shutdown ordering.

The host supplies the authoritative DSH session object and session ID. Model
arguments never select a run, repository, route epoch, resume token, lease, or
idempotency key. A route may move to another DSH session only when the run is
unambiguous and no current execution lease belongs to the previous session.

The model-visible registry contains exactly seven operations:
`enno_ideal_submit`, `enno_plan_submit`, `enno_work_report`, `enno_finish`,
`enno_meditation_submit`, `curator_check`, and `memory_checkpoint`. Intake,
advisory fanout, confirmation, final verification, and globalization are host
operations and are not published as model tools.

Capability catalogs use version 2 exclusively, with the native `skill | tool`
vocabulary. Bindings carrying any other catalog version are rejected as
integrity errors.

The DSH session log is the canonical interaction record. Kiokuko observes
`session/event` into a separate, rebuildable SQLite mirror; it never copies raw
DSH events into the 64 KiB-bounded execution ledger. Mirror listeners contain
all failures. A native `sessions.flush()` requested by orchestration remains a
fail-closed durability barrier, while the subsequent mirror checkpoint is
non-vetoing. After terminal success, the run close and durable finalization job
commit atomically. The auxiliary model call runs afterward and cannot veto DSH
completion or export.

At first admission the adapter durably binds the run to its exact DSH
`turn/start` sequence. Terminal success is accepted only with the matching
`turn/end` sequence after the native checkpoint. The finalization job stores
both boundaries, so a delayed worker cannot ingest a later run from the same
session. It rebuilds the model surface only through that immutable end,
reuses the last request's system/tools/messages prefix for provider-cache
locality, and appends weighted evidence only from the target run range.

The complete canonical Memory Capsule is limited to 65,536 UTF-8 bytes. Saved
entries contain their own text; the bounded DSH log digest and session/range
reference are provenance, not a read dependency, so normal DSH project
archiving does not break memory retrieval.

Phase receipt, handoff, outbox creation, and turn seal are one Core SQLite
transaction. `agent/turn-stopping` only kicks a leased boundary job. Separate
jobs classify, confirm, verify, collect advisory evidence, build context, flush,
and dispatch. Human messages supersede stale plugin continuation IDs without
changing user, slash-command, file, or session messages.

Every phase tool returns one `TurnOutcome`. Applied results place the existing
business response under `value` and a bounded next-turn projection under
`handoff`; expected validation failures return `retry` or `clarify` as a
successful tool envelope. Infrastructure failures remain actual failures.

Shutdown stops ingress, drains the boundary worker and restart-safe finalizer,
drains active database work and the bounded write queue, stops the embedding
worker, then closes both SQLite databases. Partial native runtime composition
fails closed instead of silently mounting a reduced safety plane.
