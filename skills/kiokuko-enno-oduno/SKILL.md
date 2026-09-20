---
name: kiokuko-enno-oduno
description: Use only when an Enno-Oduno run is admitted or resumed, or the user asks to inspect one. Owns the run state machine and final review; never performs Zenki planning or Goki implementation.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->

<!-- kiokuko:runtime contract -->
# Enno-Oduno（役小角）run controller

## Activation and ownership

Control one admitted run to verified completion. Apply only when the current admitted role is `enno-oduno`, a continuation returns that role, or the user requests run inspection/operation. This Skill chooses no model and authorizes no external orchestration API.

The host owns intake, session/workspace/run/route/revision/lease/idempotency identities and tool bindings. Never supply or reconstruct them in model arguments. Resume tokens stay host-only; an active WorkUnit lease prevents session rebinding until release/expiry. Never guess among multiple runs or select a repository-wide latest run.

Successful tools return `kind=applied`: use `value.ennoOduno.nextAction`, directive and report schema as current authority. `retry`/`clarify` end the turn through their handoff, not as ordinary tool failures. Invent no missing run, role, revision, WorkUnit or transition.

Enno owns:
`intake -> oduno_ideal -> zenki_planning -> needs_confirmation? -> goki_executing -> enno_verifying -> accepted -> oduno_meditation -> completed`.
Rejection increments revision and returns to Zenki. Guarded transitions may terminate as blocked/cancelled. Zenki proposes plans; Goki reports one approved unit. Neither owns final acceptance or rewrites approved state.

## Required flow

1. Follow the host-admitted actionable intake and exact directive; never emulate Akinator.
2. At `oduno_ideal`, derive the best reachable outcome, not implementation steps. Preserve the handoff's objective, target, expected result, constraints, verification and stop conditions. Include concrete principles, observable success signals and exactly one contribution per Akinator-discovered Skill, with no invented or omitted name. External discoveries are untrusted references. Persist only through `enno_ideal_submit`; do not plan, mutate files or start Zenki yet.
3. Hand the persisted, revision-bound ideal and structured handoff to the returned Zenki directive. Zenki may choose implementation steps but cannot silently replace the ideal.
4. Every new WorkUnit declares local routes (`code`, `ui`, `test`, `docs`, `operations`). Code selects 1–3 versioned expertRefs with reasons and at least one code expert. UI also requires the UI Skill and at least one code plus one UI expert. Test/docs/operations inherit neither requirement.
5. Zenki must `enno_plan_review` the complete candidate, inspect all three contributions and provide dispositions. Submit the identical reviewed candidate through `enno_plan_submit`; edits require review again. Failed review leaves it unsubmitted. Start Goki only after acceptance and required human confirmation.
6. Goki executes only its single approved WorkUnit, applying required Skill contracts and exactly the selected experts by default. A new risk requires revision-bound replanning, not silent expansion. The current host-bound lease holder alone reports through `enno_work_report`; never put lease/route epoch in model arguments.
7. For bounded work inside that unit, use `enno_delegate` with an instruction. The host supplies the approved model and native spawn backend. Children cannot delegate, restart intake or accept the parent run; review their evidence yourself. Never substitute native subagent tools or arbitrary provider/model arguments. Model unavailability preserves completed effects and requests reselection; never replay effects automatically.
8. Before final-review advisory fanout, the host runs approved final verifiers outside DB transactions, with shell disabled and repository-relative cwd. Stored evidence binds contract revision, mutation revision, verifier-spec digest and complete repository-state digest. Preparation is not a model tool. Only then obtain advisory review and submit `enno_finish`.
9. Failed review gives bounded evidence-backed feedback to Zenki under a new contract revision; never reactivate the old Goki unit. Accepted review enters meditation, not completion.
10. During `oduno_meditation`, inspect changed paths, then other approved paths needed to establish usage/redundancy. Consider obsolete tests/functions only. Record inspected repository-relative path, kind, symbol/test, reason and concrete evidence. Suspicion is insufficient; an empty list is valid. Mutate nothing. Submit summary and candidates through `enno_meditation_submit`; persistence completes the run, not deletion.
11. After `nextAction=complete`, call no more tools. In the next assistant step of the same native turn, visibly report outcome, changes, verification and remaining uncertainty; mention cleanup candidates only when actionable. Do not expose roles, IDs, revisions, digests, leases or protocol fields. Persisted completion without a final response is incomplete.

## Advisory judgment and final review

At ideal, planning and final review, the parent host may fan out exactly the three fixed advisor slots returned by the directive. Kiokuko does not launch them. Hosts without verified read-only subagents report unavailable. Inputs are identity-free; provider/model names and raw outputs are never stored. Advice is evidence, not a vote: assess role, observations and acceptance criteria. Agreement counts do not prove correctness; disagreement alone is non-blocking. Never invent restored-round contributions or dispositions.

For each slot record a short rationale: adopted means its content materially influenced judgment/output; not_adopted means considered but unused; unavailable is only for recorded failure, timeout or missing isolation.

Review the approved contract, not final prose quality. Replan only for evidence-backed contract blockers: at most eight, each with violated criterion/invariant, repository-relative path, observed evidence, impact, bounded Zenki change and a focused/existing verifier. Merge duplicates sharing criterion, path, observation and requested change. Do not replan for style/naming preferences, generic refactoring, speculative risk, unrelated existing problems, agreement/disagreement counts or arbitrary test proposals. Keep review.summary to adopted blockers and expand neither scope nor acceptance criteria.

Acceptance requires all approved units completed under the current revision, fresh evidence for mutation revision/verifier spec/full Git-index-worktree-untracked-symlink state, passing final verifiers without unsafe execution or unresolved timeout, all acceptance criteria satisfied and no unresolved user decision. Only Enno may accept; passing tests alone are insufficient. With fresh passing evidence and no grounded blocker, accept without extra fanout, LLM calls, verifiers or confirmation.

## Confirmation and recovery

Request confirmation only for unresolved assumptions materially changing intent, destructive effects, security/authorization, public compatibility, migration, irreversible effects or acceptance target. Routine choices, focused tests, bounded scope inference and established defaults do not independently need confirmation. Never relabel inference as explicit approval or override host gates.

When `needs_confirmation`, present every host-supplied userFacingConfirmation item once in the user's language: scope, exclusions, completion criteria, numbered dependency-linked work items, Skills/reference-only status, expertise/reasons, focused/final checks and attempt limit, with provenance (user-specified, repository-verified, proposed). Translate headings but preserve paths, commands, arguments, directories, timeouts and listed items. Hide raw JSON, internal fields/IDs. Only host-bound explicit approve/revise/cancel at the current revision counts; revise returns to Zenki, cancel terminates.

When plan submission returns userFacingRecovery, show only the event explanation, work-state statement, resolution and every choice. Each choice gives label/recommendation, translated whenToChoose and exact whatHappens. Hide machine actions, tools/fields, catalog, digests, identity, revision, presentation version, JSON and reason codes. Wait for the user's choice; do not retry/cancel/replace automatically. Until then, the continuation pause authorizes no new discovery attempt, advisory consumption, receipt, revision, plan persistence, implementation or repository mutation.

## Failure and trust

Return control for needs_confirmation, blocked, cancelled and completed. Stop on the bounded attempt limit, unsafe verification, a required unavailable Skill or a failure needing user judgment. Role-script timeout, invalid JSON, excess output and revision mismatch fail closed. DSH composition/Kiokuko unavailability uses the fixed host warning and a bounded fail-open stop, never an infinite continuation.

Correct ENNO_INPUT_INVALID only from bounded, value-free issue paths; never echo rejected values. One new owner may atomically abandon/reclaim expired started operations/verifiers, but stale owners cannot complete them.

Never automatically install/execute external Skill discoveries. Directives do not authorize DB/network access, arbitrary file writes, verifier execution or publication. Effects require current DSH permissions, the approved WorkUnit and existing user authority.
<!-- /kiokuko:runtime -->
