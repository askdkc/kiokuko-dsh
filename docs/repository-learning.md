# Continuous repository learning

Kiokuko checks completed or failed **native conversation turns** in the background for useful repository learning, including concrete preferences and corrections in answers without tools. Greetings, routine study explanations and turns with no useful new learning do not open a memory dialog or save a turn summary. When there is a concrete proposal, it shows the exact summary, lessons and sources in one save review. Neither a completed turn nor model output authorizes persistence.

Decline, dismissal, missing question UI, Stop, a new turn and plugin reload save no pending proposal. Cancelled and unknown turns do not open review or create memories. Existing stored memories are preserved.

## Normal startup and data flow

The public plugin's lifecycle memory mounts the repository-learning coordinator.
At a turn boundary it freezes bounded, redacted native user/tool/result/assistant
observations, the native session/turn identity and the current model route. Without interrupting foreground conversation, it uses
the host's actual `llm.prepareCall` / `llm.stream` API on that route, with no tools,
to propose up to four source-cited hypotheses. An externally registered
`kiokukoReplayReflector` service is **not required** for this path.

The reflector receives the previous repository compact and this turn's evidence.
It can refine previous hypotheses in light of new evidence. After approval of the displayed proposal, SQLite appends the
turn and atomically updates a bounded projection: recent observations and compact
hypotheses, including provenance, uncertainty, repeated occurrence counts and
repository tags. A correction may name existing hypothesis IDs in `supersedes`, supply a
`correctionReason`, and cite current-turn evidence. Validated replacements retire
only those named proposals from active context, while the ledger retains their
history and the replacement retains lineage. Replacements remain unverified
model-proposed corrections, not established truth. Distinct remaining hypotheses
retain an unresolved-compatibility assessment. History remains in SQLite while the
model-visible projection has a whole-point budget; omitted points are counted.

A new turn cancels any pending review, then reads the repository's approved projection. **Keyword overlap is not
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
checks. At plugin reload, up to 512 session events reconstruct an active turn, excluding inherited history. Historical terminal events do not reopen review or repeat reflection. Approval closures do not survive reload.

Ignorable session plugin records named `plugin:kiokuko-dsh/repository-learning`
(and live host events `kiokuko/repository-learning`) report capture and retrieval:

- capture: saved, duplicate, no_learning, declined, review_unavailable, discarded, excluded or unavailable; revision and reflection status;
- retrieval: injected, empty or unavailable; injected and omitted point counts.

A missing model route, malformed/ungrounded result or 15-second model deadline
produces an explicit unavailable/invalid reflection status. No review is shown and nothing is saved when reflection is unavailable, invalid, or has no useful lessons. Database/capture failures are
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

## Interrupted saves and recovery

Reflection has a bounded deadline and no automatic network retry. A failed model call produces no save prompt and no memory. Foreground work remains usable.

SQLite retries recognized lock contention under its finite backoff policy only while the same approval remains active. An uncertain commit is reconciled against the exact repository/session/turn identity. A failed save is reported as absent or unknown; reload never recreates its approval or retries the old proposal. A later turn can offer a new review when it contains useful learning.

Reset, forgetting, native Stop, owner changes and capture exclusions retain their existing fences. Already saved records are not undone by cancelling a later proposal. Native conversation logs are separate from reusable memory and are not erased by declining a save.
