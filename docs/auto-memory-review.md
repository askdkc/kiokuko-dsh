# Automatic memory review

Open top-level chats, discussions and normal/Enno runs review newly completed
human turns without waiting for the session to close. The default interval is
8 turns. A review may add a project candidate, update a candidate owned by this
feature, leave it unchanged, or hold it for later evaluation. An empty result
is a successful review. Saving a memory does not make it verified.

The next human request selects relevant memories using its current question and
the existing scope, capability and memory-use gates. Active Enno work keeps its
existing refresh owner and budgets. Saving and retrieval are separate steps;
not every saved memory belongs in every response.

## Configuration and cost

These are plugin configuration fields (under the existing `kiokuko-dsh` entry):

```yaml
memoryReview:
  mode: active
  turnInterval: 8
  minimumTurns: 4
  dailyCalls: 12
  maxInputBytes: 32768
  maxOutputTokens: 2048
  timeoutMs: 30000
  boundaryFlush: true
  notifications: changes
```

`active` can write candidates. `observe` makes the same paid model call and
records decisions but does not change entries. `off` stops periodic/manual
review; it does not disable ordinary/Deep Finalizer or Evolution. Those have
separate responsibilities and budgets. `minimumTurns` must not exceed
`turnInterval`. A nonterminal session boundary can flush at least four completed
turns. Idle alone does not lower the eight-turn threshold.

A job retains the provider/model from its confirmed native request. Unknown
context capacity, missing native indexed reading/flush, or unavailable model
service prevents dispatch. There is no fallback provider or separate small
model. One dispatched job calls the DSH stream API once with no tools; a
provider's internal HTTP retries are outside that worker-level guarantee.
Failures after dispatch consume the UTC-day allowance and are not automatically
resent. Manual retry creates a new budgeted child job.

Settings have a persistent generation shared by hosts. An older host cannot
silently overwrite a newer generation. A cold start with `mode: off` can disable
saved active settings. If requested and effective settings differ, explicitly
set the desired mode in the current project:

```text
/kioku-memory-review mode off
/kioku-memory-review mode observe
/kioku-memory-review mode active
/kioku-memory-review status --json
```

Other fields apply on first admission or a live configuration update. On cold
restart, persisted settings remain authoritative; status exposes requested and
effective modes. Mode changes do not retry cancelled or uncertain jobs.

## Inspect and recover

Status, mode and exclusion commands also work before the first task is admitted.
Run manual review and retry commands inside an admitted top-level session:

```text
/kioku-memory-review status
/kioku-memory-review status --json
/kioku-memory-review run
/kioku-memory-review retry <job-id>
/kioku-memory-review retry-finalizer <run-id>
```

`run` reviews unscheduled, completed turns. It does not resend an existing job.
`retry` accepts unresolved held/rejected/cancelled work, including a completed
job with held operations. Repeating it returns the same child job. Use that
child's ID for another deliberate attempt. Retry preserves the original model,
checks current evidence and candidates, and refuses to overwrite later adopted
evidence with an older range. Missing source logs, saved exclusions, review off,
and an active Finalizer prevent retry. Failed Finalizers retain their own
three-attempt limit; `retry-finalizer` does not consume a review call.

Status includes the scanned/scheduled/reviewed cursors, jobs and recovery
availability, provider/model, reasons, operation counts, request bytes, duration,
adoption wait, UTC-day calls and remaining allowance. Reported token usage stays
`null` when the provider did not report it. Bytes and the conservative context
admission bound are not measured tokens. Finalizer usage and Evolution calls
are shown separately. Change notifications use a native session notice, not a
new human turn. Status does not expose evidence text or raw exception messages.

A terminal run hands remaining work to an actual compatible Finalizer reservation.
Cancelled runs and failed runs without a consumer keep unresolved state; they
are not reported as reviewed. Review and ordinary Finalizer share a database
lease. Expired undispatched jobs can recover, while expired dispatched reviews
remain held because the provider result is unknown.

## Exclude this conversation

Before sensitive input, use:

```text
/kioku-memory-review exclude session
```

The exact standalone phrases `この会話を保存しない` and `この会話を覚えないで`
also exclude the entire session. Limited detection of `保存しない`, `覚えないで`,
`do not remember` and `don't remember` holds automatic capture; quotes and
hypothetical examples can therefore also cause a hold. Inputs over 1 MiB are
held when full inspection is impractical. This is not complete recognition of
arbitrary natural-language refusal.

The saved exclusion applies to review, old and new ordinary Finalizers, Deep
memory extraction, and Evolution jobs containing that session's evidence.
It fences new dispatch and adoption and requests cancellation of local in-flight
calls. It cannot retract data already sent. It does not stop normal chat/Deep
execution, erase native logs or existing memories, or disable explicit memory
tools. Exclusion survives restart; an excluded parent is inherited by a branch.
Unknown lineage is held. This version has no partial exclusion or same-session
unexclude command; start a new conversation for capture to resume.

## Evidence and retention

Only explicit human sources and paired eligible native tool observations are
new evidence. Assistant assertions, memory/control tool output and injected
memories do not become independent evidence. Model instructions require
preserving negation, conditions, corrections and temporary preferences; host
checks enforce IDs, revisions, scope, ownership, secret rejection and trust.
The model's semantic interpretation can still be wrong. Inspect important
candidates before treating them as facts.

Review input uses bounded immutable evidence manifests and candidate snapshots;
it does not copy entire native history into Core. Large inputs split only at
complete turn boundaries, carrying up to 8 KiB of earlier evidence as context
that cannot independently support another memory. If required context exceeds
that bound, the affected chunk remains held. Oversized individual units or secret-bearing units
remain held. No event-body truncation is presented as complete evidence.
Human-edited, verified, superseded and externally managed entries cannot be
automatically updated. Deleted/superseded source effects remain tombstones.

Finalizer v3 reconciles reviews and retains fact, decision, preference, lesson
and reference support. Old jobs retain their v1/v2 contract. Episode extraction
remains one per run and does not count periodic reviews as additional votes.
Source logs use existing retention; eviction makes unresolved work
`source_unavailable` rather than fetching or sending missing history silently.

## Verification

Local verification on 2026-09-19: the full suite with the pinned DSH runtime
finished with 828 passed, 0 failed and 28 environment-gated skips (856 tests).
The new feature suite contains 29 tests, including native open-chat delivery,
refusal notices, legacy v1/v2 exclusion and shared Finalizer lease recovery.
Typecheck, build, publint and package closure/import checks passed.


```bash
npm run test:memory-review
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" npm run test:memory-review
npm run test:benchmark:memory-review
```

The native integration tests exercise DSH Session, agent loop and registered
provider adapter with a deterministic mock model. They verify saving in an
open chat and retrieval on the next request with `ennoMemory` off/observe/active.
Separate tests cover two OS processes sharing SQLite, budget rollover, restart,
late results, exclusion, candidate protection and Finalizer reconciliation.

The incremental benchmark uses 10,000 / 100,000 / 1,000,000 historical events and
100 new turns each. On 2026-09-19, each read 501 native indexed events and 2,000
range rows (classification, reservation, dispatch validation and adoption
validation), buffering at most five new native events. Measured delta work was
339 / 280 / 220 ms in that local fixture, excluding seeding. This is not a claim
of zero user-response latency or real-provider performance.

Real-model extraction quality and usefulness in subsequent work are **not
measured**: no explicit live evaluation connection was supplied. Structural
fixture results do not establish semantic accuracy. Publication, installation
and verification in the user's currently running DSH profile are separate.
