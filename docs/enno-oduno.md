# 役小角(enno-oduno)

![役小角(enno-oduno)](../skills/kiokuko-enno-oduno/enno-oduno.png)

For build, debug, review, and devops work, Enno-Oduno keeps a run-bound loop:

```text
intake → ideal → plan → confirmation → WorkUnit execution → final verification → meditation
```

The loop identifies the current client, resolves Akinator intake, derives and
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
