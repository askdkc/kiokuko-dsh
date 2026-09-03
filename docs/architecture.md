# DSH composition architecture

`src/dsh/index.ts` is the only package entrypoint. Cordis mounts one composition
that owns the DSH session bridge, intake gate, model-visible tools, Enno-Oduno
controller, ledger writes, memory retrieval, optional embedding worker, and
shutdown ordering.

The host supplies the authoritative DSH session object and session ID. Model
arguments never select a run, repository, route epoch, resume token, lease, or
idempotency key. A route may move to another DSH session only when the run is
unambiguous and no current execution lease belongs to the previous session.

The model-visible registry contains exactly seven operations:
`enno_ideal_submit`, `enno_plan_submit`, `enno_work_report`, `enno_finish`,
`enno_meditation_submit`, `curator_check`, and `memory_checkpoint`. Intake,
advisory fanout, confirmation, final verification, and globalization are host
operations and are not published as model tools.

Capability catalogs use version 2 and the native `skill | tool` vocabulary.
Version 1 digest calculation exists only to verify an already-active DSH run;
new runs always bind a version 2 digest.

Shutdown stops ingress, drains active database work and the bounded write
queue, stops the embedding worker, then closes SQLite. Partial native runtime
composition fails closed instead of silently mounting a reduced safety plane.
