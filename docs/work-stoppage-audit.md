# Work stoppage audit

The 2026-11-10 incident was reproduced from a session export. `かかった` and
`未確定事項` independently matched the whole-request alternatives detector.
The resulting question was answered, but preparation re-entered the same detector
and returned `clarification_answer_available` again. The separate memory-review
300-second wait was not executed in this reproduction.

## Contracts

| Boundary | Stop condition / scope | Recovery and coverage |
| --- | --- | --- |
| Startup (`TaskStartup`) | Explicit cancellation; unavailable explicitly selected route | Preserve the task and existing choice; `task-startup.test.ts`, `startup-recovery.test.ts` |
| Interpretation (`executionClarification`, `OnDemandIntake`) | Unresolved action/reference/scope, stale source | Main-model interpretation with exact current references; quoted uncertainty is not a stop condition; `request-intent.test.ts`, `on-demand-review-regressions.test.ts` |
| Optional assessment (`assessRequestIntent`) | Concrete contradiction or invalid source binding | Missing checker degrades ordinary, fully bound main-model interpretation to advisory; preserve unavailable detector evidence; `intent-assessment-policy-recovery.test.ts` |
| Answer delivery (`clarificationClaims`) | Foreign identity or stale answer | Record waiting/queued/captured/consumed separately from ownership; exact transitions are idempotent; `clarification-delivery.test.ts` |
| Native execution | Native permission denial, Stop, invalid authority | Never replace with preparation success; `nonblocking-prepare-retry-native.test.ts`, `native-task-stop-cancellation.test.ts` |
| Lisp / delegated work | Stop, missing ownership, unknown effects, children pending | Preserve selected route and reconcile effects; `lisp/lifecycle-evidence.test.ts`, `owned-native-lifecycle.test.ts` |
| Optional memory / recording | Affects only optional operation | `reviewCompletedReplay` races extraction and questions against cancellation; task completion does not await review; `replay-memory-review.test.ts`, `lifecycle-memory.test.ts` |
| Verification continuation | Missing evidence; no progress after bounded attempts | Keep task active; never blindly resend uncertain inbox delivery; `task-completion-lifecycle.test.ts`, `loop-guard.test.ts` |
| Session close / restart | Cancellation and task ownership fences | Pending clarification is retained by both host paths; `request-intent-unresolved-lifecycle-native.test.ts`, `session-recovery-native.test.ts` |

This inventory identifies existing verifiers, not a claim that every listed
scenario passed in the current environment. Source tests, current official DSH,
packed consumers, live models and remote CI require separate results.

## Public compatibility

`prepare_requested_work` keeps its input schema. Malformed arguments now return
`invalid_preparation_request` with field paths, allowed enum values, current
references and `correct_preparation_input`. The result grants no permissions and
leaves capture intact for a corrected submission.

An ordinary main-model interpretation with current source bindings can continue
when an auxiliary checker is unavailable. The assessment keeps its actual
`semantic` and `detector` results and reports `outcome: advisory`; it does not
claim the checker passed. Scope-changing, lifecycle and protected operations
retain their existing contracts. Contradictions remain unresolved.

Migration 055 records answer delivery phases without promoting legacy
reservations: those start at `unknown`. The phase is progress evidence, not
execution authority. Restoring a native answer after process restart still
requires its source/ownership binding; phase alone must never reconstruct consent.

## Delivery reconciliation and acceptance

Replacement hosts can reconstruct answer context only from a persisted receipt
matching the exact session, agent, answer ID and content digest. Only the original
turn or its immediate continuation can restore it, and a newer question
supersedes the receipt. This restores
evidence, not execution permission; current source and scope checks still run.
Migration 056 distinguishes definitely unsent verification reservations from
uncertain dispatches. Recovery reuses the same claim and budget, verifies the
current lease and generation, and dispatches only `reserved` records. A native
exception keeps `dispatching`; admission records `observed` in both Core and
adapter. Historical rows remain `unknown`. `task-completion.test.ts` covers
interruption on both sides of dispatch and repeated recovery.

The ordinary continuation outbox is reconciled against positive native
`user/message` observations, including session restart. Session, delivery ID,
source and content must match. No event never means safe to resend. Existing
unreserved pending deliveries retain the leased worker route; reserved or
uncertain deliveries are never replayed. `loop-guard.test.ts` covers foreign
sessions, altered payloads, missing events and repeated observation.

Direct and inert PTC preparation share `status`, `reason`, `blockedScope`,
`nextAction` and unchanged native permissions. Malformed canonical carriers
return correction details without executing JavaScript or consuming admission;
noncanonical programs and native denials retain their own execution policy.
`request-intent-retry-native.test.ts` tests both transports, corrected input,
changed references and native denials.

`coding-web` uses the installed archive and Chromium to implement a file, run
its regression and public command, display the result, and reopen a retained
session. Its request includes both incident phrases. `dsh-cli-packed` installs
the archive into an empty consumer, then runs the actual CLI PTY with the
installed plugin entry, Stop, Lisp result, transfer and persisted resume checks.
The child checks the loaded factory bytes. The fixed DSH fixture revision is
recorded by the central verifier. Both cases use a scripted provider: they prove
host behavior, not live-model interpretation accuracy.

The central `scripts/verification.json` includes these checks; recursive native
unit/integration selection includes the new regression files. The packed CLI
check is also assigned to the `ci-main` consumer lane. Final verification receipts
are emitted outside the source tree to avoid changing the verified digest.
Remote CI for an uncommitted local diff and live-model evaluation are distinct
from this local acceptance and must not be inferred from it.
