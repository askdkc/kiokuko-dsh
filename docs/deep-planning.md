# Deep planning

`/deep-planning` runs bounded, read-only investigation, analysis and planning
inside the current registered workspace. It uses native DSH child agents for
decomposition, solving, critique and synthesis. It does not edit project files
or move automatically into implementation.

```text
/deep-planning Design a migration strategy for this repository.
/deep-planning --status
/deep-planning --cancel
/deep-planning --resume
/deep-planning --configure
/deep-planning --help
```

Without an argument, `/deep-planning` reserves the next ordinary human message
in this Session, once. Use `/deep-planning -- <text>` when the problem starts
with a flag. Multiline text and code are retained. Images/attachments are
retained but rejected for analysis; cancel and provide text instead.

## Models, configuration and budgets

Deep uses its saved workspace configuration, or the exactly resolvable current
DSH connection for all four roles. Otherwise it opens a configuration card.
Models come from DSH's registered catalog; there is no provider substitution.
Configuration drafts are saved after each submitted change. Closing a card or
disconnecting the UI does not cancel the work or discard its problem.

Settings apply to future work in the same database/workspace. Existing
reservations and runs keep their snapshot. Applying new settings to a paused
run requires the explicit card action and does not reset consumed budgets.

| Limit | Default |
| --- | ---: |
| Concurrent agents per run / process | 3 / 6 |
| Decomposition depth / cumulative nodes / children at once | 4 / 32 / 3 |
| Replans per node | 2 |
| Agent jobs / observed model requests | 48 / 80 |
| Total estimated tokens / maximum output per request | 120,000 / 4,096 |
| Active time | 600 seconds |

Local connections start at one concurrent agent. Waiting runs receive slots
in round-robin order. Ancestors do not hold slots while their children work,
so nested aggregation also works at concurrency one.

Token admission is **estimated**, using request bytes plus reserved maximum
output. Complete provider usage is preferred for settlement. Missing or
uncertain usage retains its estimate; it is never counted as zero. Limits
cover native normal streams, prepared calls, retries, auxiliary calls and
Deep memory extraction at the observed `llm/stream` boundary. Unobservable
provider-internal retries and exact monetary charges are not guaranteed.
Explicit pause time is excluded; resume does not replenish spent time.

## Recovery and answers

Additional input is saved and pauses new jobs while live jobs are drained.
The recovery card offers adding constraints, cancelling and starting a new
problem, or retaining the input while continuing the current work. Added
constraints advance the requirement revision and conservatively invalidate
earlier acceptance. Unsupported attachments cannot become constraints.

`--resume` targets only this Session. Unknown attempts are checked against
their exact child Session records. Without a reusable completion record,
retry requires the explicit **費用発生の可能性を確認して再試行** choice.
Their original reserved usage remains charged. Another live process's lease
prevents takeover or cancellation from this process; stop it there or wait
until its ownership expires. Expired ownership does not make unknown calls
safe to resend automatically.

The host assembles answers from saved candidates, even with no model budget
remaining. Verified results, provisional candidates, assumptions and unresolved
requirements are distinguished. Evidence receipts describe schema, reference,
coverage and source-content checks, plus a critic assessment. They are not
formal proofs of natural-language correctness.

Answer persistence and delivery are separate. A report outbox records the
answer atomically with run completion. The authenticated Web endpoint resolves
the exact Session and workspace; the **Deepの回答** header action opens the saved
answers. The browser acknowledges the stable report ID only after rendering.
Disconnected clients leave delivery pending. `--status` also returns the saved
answer through the ordinary native command result. No report event is appended
to the native log: DSH 0.1.2-rc.1 and 0.1.5-rc.1 drop the external event `ignorable` append
option and would reject that log on reopening. The next ordinary input returns to
the existing normal/Enno selection rules and receives a bounded, untrusted
summary of this Session's last Deep report.

Memory extraction uses the fixed report, accepted evidence and configuration
snapshot. It does not borrow an old parent model header or fabricate a native
turn. It reserves from the same budget, can be visibly skipped, and never
automatically resends a Deep extraction left uncertain by a crash. Memory or
Orca failure does not prevent answer delivery. Deep children inherit their
exact parent's existing Orca choice; they do not prompt or enable capture.

## Boundaries and storage

The pure core in `src/deep-thinker/core` imports neither DSH nor the database.
The controller, store, executor, reader and report port own their respective
effects. Enno retains its own authorization callbacks and acceptance rules;
only native child creation/binding/result/disposal mechanics are shared.

Migration 013 adds Session ownership shared by normal/Enno/Deep, Deep intents,
configuration drafts, graph nodes/edges, attempts, artifacts, evidence receipts,
budget reservations, report outboxes and finalization claims. Source and
configuration revisions, process leases and owner epochs fence results.
External effects run outside database transactions and the write queue.

Children can only use `deep_read_file`, `deep_list_files` and
`deep_search_files`. Reads are workspace-bound, reject symlinks and binary
files, and have size/scan limits. Citable reads store host-issued artifact IDs,
line ranges, content digests and full source digests. Sources are rechecked
before result acceptance, recovery, final reporting and memory saving.
Artifacts are limited to 256 per run, each with at most 16 KiB of text;
individual source files are limited to 1 MiB. Search inspects at most 2,000
entries and returns at most 100 matches. Shell, writes, arbitrary MCP calls,
grandchildren and parent completion tools are unavailable.

The capability contract is tested against the published DSH `0.1.5-rc.1`
package graph. Unsupported environments fail closed with an explanation.
Deep-owned input never falls back to an ordinary model request.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run publint
npm run pack:check
KIOKUKO_REQUIRE_DSH_CLI=1 KIOKUKO_REQUIRE_DSH_NATIVE=1 \
  KIOKUKO_DSH_PACKAGE_ROOT=/absolute/path/to/pinned/node_modules \
  DSH_BIN=/absolute/path/to/pinned/node_modules/.bin/dsh \
  npm run test:e2e:dsh
```

Use Node 24.16 or later and a disposable DSH profile. Mandatory native runs
fail when native tests are skipped. `deep-planning-native.test.ts` is collected
by the repository test runner. Native recording-adapter fixtures establish
integration behavior, not live-provider answer quality or efficiency gains.
No model-quality, cost-saving or speed claim follows from these fixtures.

See [the local verification record](deep-planning-verification.md) for the
tested runtime, visible Web checks and remaining evidence limits.
