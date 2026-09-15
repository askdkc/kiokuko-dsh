# 役小角(enno-oduno)

![役小角(enno-oduno)](../skills/kiokuko-enno-oduno/enno-oduno.png)

For build, debug, review, and devops work, select normal execution or Enno-Oduno
at task entry. See [execution and model selection](model-selection.md).
When selected, Enno-Oduno keeps a run-bound loop:

```text
intake → ideal → plan → confirmation → WorkUnit execution → final verification → meditation
```

The loop binds the current DSH session, resolves Akinator intake, derives and
persists an ideal outcome, and hands a revision-bound plan to Zenki. Zenki divides
changes into cohesive WorkUnits; Goki may execute only approved units. A WorkUnit
has one responsibility, one reason to change, focused checks, and local code/ui/test/
docs/operations routes.

Confirmation displays scope, exclusions, completion criteria, skills, expertise,
commands, and timeouts as structured Markdown in the original task's English or
Japanese language. Paths, command arguments, identifiers, and exact timeout values
remain unchanged. The surrounding card title and buttons use the DSH UI locale;
Kiokuko owns only the Markdown plan body. Internal IDs and raw JSON remain hidden.

If the plan environment is missing or changed, recovery pauses before discovery,
plan persistence, or implementation. The user chooses continue, review, restart, or
cancel. Continuation uses a short-lived route-epoch-bound resume token and one-owner
execution lease; expired leases can be reclaimed safely. Ambiguous active runs are
not rerouted.

If a DSH model request fails during WorkUnit execution, Kiokuko does not replay
the interrupted model or tool action. The next user turn resumes the same run
only after revalidating its DSH session, revision, and WorkUnit and rotating the
execution lease, including after the previous lease expired.

Final Review first runs approved verifiers with shell disabled and repository-relative
paths. Evidence is bound to the contract revision, mutation revision, verifier
specification, and repository state. `enno_finish` accepts only complete passing
evidence. A failed review returns to Zenki for a new revision; it never resumes Goki
directly. An accepted review enters read-only Oduno meditation, which records
evidence-backed obsolete test/function candidates without deleting them.

At ideal, planning, and final-review phases, the parent host may use three isolated
read-only Advisory Round slots. Kiokuko does not launch advisors; unverifiable slots
are reported unavailable and only the parent submits bounded, identity-free results.

## Optional memory refresh during execution

`ennoMemory` uses new errors, WorkUnit targets and current user constraints at the next
safe request boundary. The normal preStep and the persistent boundary worker's context
stage use the same service. Intake, plan approval, execution leases and final verification remain authoritative.

```yaml
- id: kiokuko-dsh
  config:
    ennoMemory:
      mode: active
      maxFullSearchesPerRun: 8
      localBudgetMs: 1000
      rerank: false
    efficiency:
      observe: true
```

- `mode` defaults to `off`. `observe` records decisions without extra retrieval, embeddings,
  context replacement, database writes or feedback. `active` enables Reuse / Full.
- `maxFullSearchesPerRun` is 1–32, default 8, excluding intake. Reservations survive failures,
  retries, restarts and competing hosts; failed reservations are not refunded.
- `localBudgetMs` is 100–5000 ms, default 1000. Elapsed time includes corpus validation.
  Synchronous SQLite cannot be forcibly stopped at that deadline; late results are discarded.
- `rerank` must be `false`. Candidate reranking has not met the separate adoption criteria.

After a successful selection, repeated errors under different call IDs do not cause another
Full search. Retrying a failed search at a later boundary also consumes the run budget.
Role/revision-only changes reuse selected references bound to the current run state. New evidence or corpus
changes use the existing federated search and capability gate. Current snapshots lost during
compaction are restored without duplicate memory messages.

Only correlated final native tool results and host-owned verifier outcomes are evidence.
Scanning is limited to 8 KiB per result, with up to 16 signals of 192 Unicode code points each.
Delegated children do not start refreshes. Numeric observations are available through the existing
efficiency observer; no query, tool-output, path or memory-body log is added.

The standard host currently supplies an off embedding runtime, so refresh uses lexical retrieval.
It adds zero LLM or remote embedding calls and never downloads a model. A required embedding
contract that cannot be fulfilled causes additional memory to be omitted.

Cold resume does not restore an old delivery. Off/observe retain the existing empty context;
active may make a new selection within the durable budget and current authority. Change `mode`
to `off` to invalidate pending results and additional selections. Only currently valid baseline
memory can remain. Final request fences still reject deleted, superseded or inapplicable memory.
Optional retrieval failure never discards the original human input or bypasses execution authority.

Real-model quality and token savings are unmeasured. See [evaluation evidence](enno-memory-evaluation.md).
