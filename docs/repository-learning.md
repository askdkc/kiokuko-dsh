# Continuous repository learning

Kiokuko automatically checks each **native conversation turn** (`turn/start` through
`turn/end`), not every token or intermediate model step. Task completion and a
post-task approval dialog are not prerequisites. Failed, cancelled, no-tool and
unknown turns are retained as those lifecycle observations, never as verified task
success.

## Normal startup and data flow

The public plugin's lifecycle memory mounts the repository-learning coordinator.
At a turn boundary it freezes bounded, redacted native user/tool/result/assistant
observations, the native session/turn identity and the current model route. It uses
the host's actual `llm.prepareCall` / `llm.stream` API on that route, with no tools,
to propose up to four source-cited hypotheses. An externally registered
`kiokukoReplayReflector` service is **not required** for this path.

The reflector receives the previous repository compact and this turn's evidence.
It can refine previous hypotheses in light of new evidence. SQLite appends the
turn and atomically updates a bounded projection: recent observations and compact
hypotheses, including provenance, uncertainty, repeated occurrence counts and
repository tags. A correction may name existing hypothesis IDs in `supersedes`, supply a
`correctionReason`, and cite current-turn evidence. Validated replacements retire
only those named proposals from active context, while the ledger retains their
history and the replacement retains lineage. Replacements remain unverified
model-proposed corrections, not established truth. Distinct remaining hypotheses
retain an unresolved-compatibility assessment. History remains in SQLite while the
model-visible projection has a whole-point budget; omitted points are counted.

Before subsequent model steps, the coordinator waits for preceding repository
learning and reads that repository's projection directly. **Keyword overlap is not
required**. A new session in the same canonical repository gets the accumulated
compact; another repository does not. Root identity comes from trusted host cwd
and repository resolution, not model-supplied tags. The injected section is
`memory:repository-learning`, not an "approved" memory. It explicitly labels its
contents as fallible reference data, never instructions, permissions or verified
success. Prior persisted projections are retired so obsolete notes do not remain
on the active prompt surface.

## Durability and diagnostics

Migration `048_repository_learning.sql` adds the append-only turn ledger and
bounded repository projection. Idempotent session/turn identities prevent duplicate
records. Updates use an immediate SQLite transaction and capture-policy revision
checks. At plugin reload the latest native turn is reconstructed from up to 512
session events (excluding inherited fork history); already saved turns are not
reflected again. Earlier unsaved turns beyond this bounded recovery window are not
claimed recovered.

Ignorable session plugin records named `plugin:kiokuko-dsh/repository-learning`
(and live host events `kiokuko/repository-learning`) report capture and retrieval:

- capture: saved, duplicate, excluded or unavailable; revision and reflection status;
- retrieval: injected, empty or unavailable; injected and omitted point counts.

A missing model route, malformed/ungrounded result or 15-second model deadline
produces an explicit unavailable/invalid reflection status. The observed turn can
still be saved without invented model lessons. Database/capture failures are
reported as unavailable, not silently described as successful saving. This feature
never launches DSH, changes repository source, runs learned commands or grants tool
permissions.

Existing "do not remember" capture refusals and exclusion revisions are respected
before dispatch and commit. Retraction conservatively purges all learning in the affected repository, including
later-session derivatives. Existing entry forget purges learning in its workspace.
A persistent admission epoch rejects previously admitted delayed results, including
results from another session. Unrelated stored repositories are preserved.
`/kioku-memory learning status` shows safe counts and revision;
`/kioku-memory learning reset` clears the current trusted repository only and
invalidates pending admissions. Payload-free turn identities prevent deleted turns
from being recovered and learned again after reload. Native conversation logs and provider transcripts
are not erased by these commands.
Known secrets are filtered/rejected. These safeguards and explicit untrusted-data
framing are not a claim of perfect semantic prompt-injection detection.

## What is and is not guaranteed

The implementation makes repository learning available in later model inputs when
storage and the host route are available, with observable failures. It does not
force a model to follow a lesson, prove that a lesson is correct, or claim measured
success-rate improvement. Native integration tests use the real DSH plugin/model
routing and controlled model responses; they are not live-provider effectiveness
measurements. Source application alone does not update an already running DSH
process.
