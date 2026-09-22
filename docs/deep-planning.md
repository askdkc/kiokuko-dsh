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
Choose a provider/model row once, then return directly to role review and save.
DSH supplies authentication and transport; the card never asks you to re-enter
provider family, protocol or connection type. Use the displayed Cmd+1–9 (macOS)
or Ctrl+1–9 (Windows/Linux) shortcuts, then Enter to confirm. Search text and
numeric budget values remain literal.
Configuration drafts are saved after each submitted change. Closing a card or
disconnecting the UI does not cancel the work or discard its problem.

Settings apply to future work in the same database/workspace. Existing
reservations and runs keep their snapshot. Applying new settings to a paused
run requires the explicit card action and does not reset consumed budgets.

### Experimental quality mode

Standard reasoning remains the default. To enable quality mode, open
`/deep-planning --configure`, choose **推論: 通常** → **品質重視（実験）**,
select **別案のモデル**, and save. The alternative may use the same exact
provider/model as the solver; its identity is preserved in the run snapshot.
Switch back to **通常** for future work. A paused run keeps its original mode.

Quality mode reviews the plan's checks, produces two answers without showing
either worker the other answer, then compares every candidate against every
check. Each child's assigned checks must cover exactly its own requirements;
a sibling covering a missing requirement cannot compensate for that omission.
The critic may select a candidate, request one repair or synthesis followed by
another review, replan within the existing limit, or leave the problem unresolved.
Agreement never skips the critic. Synthesis creates another candidate that must
be checked; it is not presumed better than either original answer.

For a leaf with no retries or replanning, standard mode uses three agent jobs;
quality mode uses five, or seven with repair/synthesis. Decomposition, JSON
repair, tool-driven model steps and memory extraction add work. These job counts
are **not** token or price multipliers. Quality mode does not increase the total
budget, so it can exhaust that budget with fewer solved subproblems.

Using the same model is permitted. [Self-Consistency](https://arxiv.org/abs/2203.11171)
reports benefits from multiple samples of one model on reasoning benchmarks;
it does not establish a benefit for this implementation. Neither matching
answers nor different model names establish correctness or statistical
independence. Quality mode remains experimental: there is no consensus-based
acceptance shortcut, model-family ban, repeated recompression or extra hierarchy.

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
answer for the **current run** through the ordinary native command result. If
that run has no report yet, it shows only its state; earlier reports remain in
**Deepの回答**. No report event is appended
to the native log: DSH 0.1.2-rc.1 and 0.1.5-rc.1 drop the external event `ignorable` append
option and would reject that log on reopening. The next ordinary input returns to
the existing normal/Enno selection rules and receives a bounded, untrusted
summary of this Session's last Deep report.

Quality reports begin with the selected candidate, the critic's overall reason,
whether any correction allowance was used, and unresolved counts. **未解決・制限**
counts distinct unfinished-node/candidate limitations in the report;
**未解決の指摘** counts current critic issues across non-superseded nodes.
Details show each candidate's assessment and reason for each check, plus the
critic's agreement, contradiction, complementary or unknown assessment.
**未選択** means another answer was chosen, not that this answer was wrong;
**未評価** means no assessment of that candidate/check has been recorded yet.
Correction allowance usage can include an interrupted correction, not a
successfully reviewed fix. These are analytical assessments, not proofs.

Report rendering makes no model requests. Quality display text retains the
summary before the answer and details and stays within 131,072 characters.
Shortened summaries and omitted trailing text are explicitly marked. Complete
structured candidates, checks and reviews remain in the saved report, and
earlier completed reviews remain in attempt records. The Web view and
`--status` use the same display text; neither is a full structured-record viewer.

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

### Manual paired comparison

Prepare three fixed problems and their scoring rubrics before running either
mode. Use the same frozen repository revision and files for every pair:

| Problem | Fixed prompt | Score against |
| --- | --- | --- |
| Facts from sources | List Deep's default limits and allowed child tools, citing their definitions. | Exact limits/tool names in the frozen contracts and executor, with valid references. |
| Counterexample | Assess a decomposition where child A owns R1/R2 but only checks R1, while child B checks R2. | Identification of A's missing check, a concrete counterexample, and a fix that still permits shared requirements. |
| Combining sources | Explain how a saved Deep answer reaches Web and `--status`, including interruption and multiple runs. | Consistent tracing of controller, outbox, report port and endpoint; no invented delivery or retry guarantees. |

1. Use disposable registered workspaces/profiles with identical source files,
   initial memory, context, role models (including reasoning settings) and
   budgets. Start a fresh Session for each run. Do not feed the first result or
   its newly extracted memories into the other mode; reset the disposable
   environment to the same starting conditions. Keep ordinary user profiles
   untouched.
2. Run each prompt once in standard mode and once in quality mode. Initially
   choose the same solver as the alternative to isolate the workflow change.
   Record any different-alternative experiment separately. Alternate which mode
   runs first across problems, and record failures and exhausted budgets too.
3. Grade each rubric item as satisfied, incorrect or unresolved from the actual
   sources, preferably without seeing the mode label. Record unsupported claims
   separately; do not use the mode's own critic assessment as ground truth.
4. For every run record model bindings, final phase, satisfied/total items,
   incorrect claims, unresolved items, requests, token count with its estimation
   status, and elapsed wall time. Use the same start/end boundary for timing and
   account for memory extraction separately when it finishes after the answer.
   Compare requests, tokens and time as well as correctness; do not infer billed
   cost from estimated tokens. If conditions differ, mark the pair incomparable.

Keep raw per-problem results, including regressions. Three problems are a smoke
comparison, not evidence of a general quality improvement. Do not change the
default or claim gains without a larger repeated, independently graded study.
These steps are manual; ordinary tests and CI do not call paid model providers.

See [the local verification record](deep-planning-verification.md) for the
tested runtime, visible Web checks and remaining evidence limits.
