# Memory request rebuild contract

Native requests are immutable. A refresh of an in-memory context object does
not update the native session surface from which a retry builds its messages.
The request fence must validate the same owner and memory projection that the
provider will receive.

## Findings and repair

The checkout already contained the earlier quarantine fix (`c77d428`), which
retires rejected optional memory from the native surface. The reported November
6 failures were from an older installed build; their identical canonical
messages alone do not identify the failing boundary. This investigation does
not claim to reconstruct those four historical attempts.

The current source still had independently reproducible defects:

- Conversation refresh replaced its context but did not append the refreshed
  projection to the native retry surface.
- Core execution refresh had the same missing delivery step. The adapter's
  refresh instead cleared its context without retrieving the current task
  corrections.
- Another invalidation after the first rebuild always exhausted the retry;
  there was no distinct recovery that omitted optional memory.
- Conversation validation did not retain the original session object or
  recheck ownership after database waits. Identity failures could be caught as
  optional-memory outages.
- Follow-up PLAN verification found two additional timing gaps: an update just
  after retrieval was pruned without fetching its replacement, and an update
  after the asynchronous fence had returned could still reach the provider.
  Four deterministic native cases (two per host) failed before closing these gaps.

`reconcileDshMemorySurface` now retires obsolete owned snapshots and appends the
current projection through the native append API. It preserves human messages,
tool results and their identities, and the historical event log. Both execution
hosts and conversation refresh use the same surface contract. Adapter refresh
reads task corrections with the original scope and rechecks the task lease and
native ownership before publishing its result.

Conversation preparation now refreshes an invalidated selection before request
assembly. A successful asynchronous validation returns a synchronous dispatch
guard: after all validator waits, it rechecks native ownership, cancellation,
current memory and forgotten explanations without another asynchronous wait
before dispatch. A change at this boundary enters the same bounded surface
repair path. This guard applies to both conversation and execution hosts.

The bounded recovery states are:

1. Validate the assembled request. A stale owned snapshot triggers one refresh
   and native rebuild before any provider dispatch.
2. If that rebuilt request also becomes stale, retire optional memory from the
   surface and request one **memory-free** rebuild. This is a different operation,
   not a higher allowance for identical retries.
3. Validate again, including ownership, cancellation and forgotten explanation
   results. Failure here stops the affected request; it never delegates the
   owned failure to generic provider retries.

The omission applies to the current native step. A later step/turn can use memory
again. Generation, human-approved storage, and retrieval are not disabled.
Recovery can originate only from the pre-dispatch validator and is bound to a
one-use failure ID plus turn/step. Errors or partial output after provider
dispatch do not enter this memory retry. Request signals are per call; a finished
foreground turn's signal must not cancel later memory generation.

Same-content storage uses the existing idempotent entry contract and does not
force a refresh. Revision, eligibility, scope, provenance and projection checks
remain authoritative; equality of rendered messages is never an authorization
or freshness shortcut. Diagnostics use recovery codes and opaque request IDs,
not memory bodies.

## Verification

- `memory-rebuild-native.test.ts`: real native session, harness, tool dispatch and
  provider boundary for Core and adapter; idempotent save, metadata-only revision,
  change after retrieval/assembly/asynchronous validation, repeated change during
  rebuild, latest transmitted content, memory-free recovery, next-turn reuse,
  and exactly one completed file write. After continuous conflict, the real
  reflection route generates a proposal, native review approves its exact text,
  storage succeeds, and the next native turn receives the saved learning.
  Against the original checkout, 8 of 10 cases failed; idempotent cases passed.
- `answer-context-boundaries.test.ts`: Stop, same-ID session replacement and
  workspace changes during preparation, projection, fence and rebuild waits,
  and after asynchronous validation before dispatch. Parallel sessions in two
  repositories retain separate projections and cancellation.
- `memory-request-fence.test.ts`: bounded recovery, failure identity, rejected
  omission, Stop during waits, partial provider output, and no post-dispatch
  memory retry.
- Existing `memory-evidence-native.test.ts`, `memory-evidence.test.ts`,
  `lifecycle-memory-native.test.ts` and `on-demand-review-regressions.test.ts`
  cover forgetting and derived evidence, approved generation/storage and reopen,
  storage failures, deferred retrieval and recovery.

| PLAN boundary | Evidence |
| --- | --- |
| Same content vs metadata revision vs changed content | Native idempotent, metadata and replacement cases; revision/projection checks are retained |
| Empty, deleted or invalidated evidence | Existing empty-context lifecycle tests, native forget race, transitive derived-evidence retirement |
| Retrieval, assembly, repeated rebuild, post-validation update | Native timing cases, actual received messages and provider dispatch count |
| Concurrent sessions, identity and Stop | Parallel repository/session test and 15 wait/dispatch invalidation cases |
| Retrieval/storage failure | Existing deferred-memory timeout/recovery and rejected evidence-write rollback tests |
| Partial output, uncertain operation, duplicate side effects | Fence rejects post-dispatch retries; native completed write remains exactly once |
| Memory generation, approval, storage and later use after recovery | Both execution host cases run the native repository reflection and two-stage approval after continuous conflict |

These are deterministic boundary tests, not replay of the four historical
failures or an exhaustive schedule of arbitrary third-party transport middleware.

Native providers in these tests are scripted. They observe actual submitted
requests, but do not verify a live provider, the user's installed Web profile,
or the old DSH `0.2.2-rc.1` environment. The tested fixture is the staged official
DSH revision `8bd073392eef6f54e921a093b95076248eb08cbb`; the plugin is the local
`0.2.51` source and its generated distribution. Updates after a provider has
already accepted a request cannot retract that request or justify replaying it.
