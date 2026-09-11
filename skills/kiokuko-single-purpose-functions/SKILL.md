---
name: kiokuko-single-purpose-functions
description: Use for any code work — writing, changing, reviewing, or debugging. Apply the function contract, then read only the expert fragments the change's actual risks select.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose function router

## Outcome

Create code whose functions each own one cohesive, externally observable responsibility, with explicit concepts, representation boundaries, effects, failures, and focused verification — in any language, framework, or repository.

This index is the execution envelope for code work. Read it completely, select the smallest sufficient expert set, then read only those expert files.

## Universal core

Applies to every created or changed function:

1. State one contract: input, success, expected failures, effects, observable result.
2. Name the user-visible or domain concept, its input and output, and what must stay private before choosing a storage, framework, transport, or UI representation. Keep this proportional; a representation-preserving mechanical change needs no separate design artifact.
3. One responsibility, one reason to change. No meaningless micro-functions.
4. Validate hostile input at the boundary; keep the private core constrained by types or validated values.
5. Do not mutate caller-owned input unless mutation is the explicit API contract.
6. Keep domain decisions deterministic; make persistence, network, filesystem, process, clock, randomness, UI, and logging effects explicit.
7. Return or throw failures intentionally. Never swallow, partially succeed, or leak a lower-layer accident as the public contract.
8. Verify changed behavior with the smallest meaningful runnable check. Add or modify a test when it protects a material behavior, failure boundary, or regression, reuse existing coverage when that suffices, and skip implementation-mirroring tests for trivial, reversible, low-impact changes.
9. Preserve unrelated code and existing public behavior unless the task explicitly changes it.

Cohesion is the objective, not smallness. Keep operations together when splitting them would hide sequencing, duplicate policy, or weaken a transaction.

## Expert selection

For each new or materially changed function, or for the smallest WorkUnit owning one cohesive use case: classify the dominant risk, select one expert below, add at most two more only when the same contract genuinely crosses those risks, record a concrete reason for each, and read the selected files before implementation or review. A different expert set or reason to change means a separate WorkUnit or a separate function contract inside it.

Enno-Oduno plans bind `expertRefs` to the WorkUnit revision: a `code` route requires at least one `code.*`, a `ui` route requires `code.*` and `ui.*`, and `test`, `docs`, and `operations` routes inherit neither. Outside Enno-Oduno, keep the same mapping in the working plan or review notes:

```text
target -> responsibility -> expert IDs -> focused verifier
```

Do not load unselected fragments “just in case.” If repository evidence exposes a new risk, update the selection explicitly before consuming that fragment.

## Expert index

| Expert ID | Select when the contract owns | Read |
| --- | --- | --- |
| `code.boundary.v1` | parsing, validation, authorization, ownership, untrusted input | [boundaries-and-ownership.md](references/boundaries-and-ownership.md) |
| `code.domain.v1` | domain rules, state transitions, narrow types, deterministic decisions | [domain-and-types.md](references/domain-and-types.md) |
| `code.effects.v1` | database, filesystem, network, process, transaction, resource lifetime | [effects-and-data.md](references/effects-and-data.md) |
| `code.protocol.v1` | retry, idempotency, concurrency, revisions, external/public protocols | [protocols-and-idempotency.md](references/protocols-and-idempotency.md) |
| `code.verification.v1` | regression repair, test design, review, compatibility or failure evidence | [verification.md](references/verification.md) |
| `code.modeling.v1` | problem shaping, public data design, domain vocabulary, or translation between storage, API, serialization, and UI representations | [problem-shaping-and-language.md](references/problem-shaping-and-language.md) |

Common selections: pure calculation → `code.domain.v1`; request parser → `code.boundary.v1` + `code.verification.v1`; transactional write → `code.effects.v1` + `code.protocol.v1`; public response or API repair → `code.boundary.v1` + `code.protocol.v1` + `code.verification.v1`.

## Escalation references

Read [kiokuko-patterns.md](references/kiokuko-patterns.md) only when a selected fragment needs a fuller example. Read [review-checklist.md](references/review-checklist.md) for comprehensive review or final verification — a change crossing several code contracts, or the last check before accepting — not for an ordinary edit inside one cohesive contract, which uses the focused `verification.md` sequence.

## Completion report

Report the function or WorkUnit contracts changed, the selected expert IDs, the focused verifier results, and anything left unverified. A build alone does not prove boundary, failure, or interaction behavior.
