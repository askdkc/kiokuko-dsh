# DSH composition architecture

`src/dsh/index.ts` is the only package entrypoint. Cordis mounts one composition
that owns the intake gate, model-visible tools, Enno-Oduno controller, run
ledger, post-completion DSH-log finalizer, memory retrieval, optional embedding
worker, and shutdown ordering.

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

The DSH session log is the canonical interaction record. Kiokuko does not
observe and copy `session/event`, and it does not register a `session/flush`
listener. After Enno reaches a real terminal success, the host waits for DSH's
own session checkpoint and atomically commits the run close plus a durable
memory-finalization job. The auxiliary model call runs afterward and cannot
veto DSH completion or session-log export.

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

Shutdown stops ingress, resolves terminal run commits, aborts or drains the
restart-safe finalizer, drains active database work and the bounded write queue,
stops the embedding worker, then closes SQLite. Partial native runtime
composition fails closed instead of silently mounting a reduced safety plane.
