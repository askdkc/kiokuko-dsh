---
name: kiokuko-soul
description: Use on every non-trivial Kiokuko-governed DSH request as the mandatory first-read SOUL router. Continue only after the DSH host has admitted the request through Akinator, then route applicable Enno-Oduno control, simple code work, general code work, and interactive UI work to the bundled specialist Skills.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Outcome

Start every non-trivial Kiokuko-governed task by reading one stable router, resolving the Akinator intake gate, then reading the applicable compact specialist indexes and only the expert fragments required by the current role and work.

This Skill owns the entry sequence and routes work. Akinator is the mandatory intake state machine, not a specialist route. This Skill does not duplicate specialist instructions, invent an Enno-Oduno run, select another model, or authorize effects beyond the user request and current DSH session permissions.

## Required entry

Read this Skill before any other bundled Kiokuko Skill.

The DSH host performs Akinator intake before the admitted model request and
supplies the resulting state and exact current directive. `task_prepare` and
`task_answer` are host operations, not model tools. Do not call them or treat
their absence from the model tool list as an error.

Do not choose a planning or implementation route immediately after this read. Enter the Akinator intake gate below first. Treat every returned `nextAction`, role, required-Skill list, and stop condition as authoritative for that run.

Read the complete `SKILL.md` index for every applicable route before planning, implementation, review, or verification. Each specialist index defines versioned expert fragments. Read only fragments selected by the approved WorkUnit or concrete task risk; do not load every reference by default. Do not substitute this router's summary for a specialist core contract.

## Akinator intake gate

Akinator is the mandatory state machine between this SOUL read and every planning or implementation route. It applies whether or not Enno-Oduno is applicable.

The DSH host opens this gate once for the current logical request, binds the
native session identity and complete capability catalog, resolves grounded
answers, and withholds the model request while intake remains unresolved.

For an admitted request, inspect the supplied `intake.status`, top-level
`nextAction`, `memoryPolicy`, capability results, and `ennoOduno` state. The
model should normally see `ready` or `exhausted` with `nextAction=proceed`.
Preserve any remaining uncertainty and do not invent missing profile fields.
If host admission fails or a required capability is unavailable, stop with the
bounded host error; do not emulate intake in model output.

## Routes

Enter planning and implementation routes only after the Akinator gate reaches `ready` or `exhausted` and top-level `nextAction` permits progress. Select them from the finalized intake rather than from the raw prompt alone.

### Enno-Oduno control

Read and apply `kiokuko-enno-oduno` only when its activation boundary is satisfied:

- the admitted DSH context has `ennoOduno.applicable=true` for the current `enno-oduno` role;
- a continuation directive resumes that role for an existing run; or
- the user explicitly asks to inspect or operate an Enno-Oduno run.

Do not invent a run, role, revision, WorkUnit, or state transition merely because Kiokuko is present.

### Simple code work

Read and apply `kiokuko-simple-work` when either condition is true:

- the request is a bounded code change with a clear target and expected result, and it introduces no new architecture, dependency, data migration, public protocol, security or authorization policy, or cross-system orchestration;
- the user explicitly requests the simplest, shortest, minimal, YAGNI, dependency-free, or Ponytail approach.

This route minimizes the solution; it does not replace the code contract below or waive required understanding, boundary validation, error handling, security, accessibility, or focused verification. If the task's simplicity is unclear and the user did not explicitly request this route, use the ordinary code route without it.

### Code work

Read and apply the `kiokuko-single-purpose-functions` index before writing, modifying, debugging, refactoring, or reviewing code, and before decomposing a code-changing WorkPlan. Select one to three `code.*` expert fragments for each cohesive function or WorkUnit.

### Interactive UI work

Read and apply the `kiokuko-ui-design-soul` index before designing, implementing, modifying, debugging, or reviewing an interactive interface. Select one to three `ui.*` expert fragments for the actual interaction risks. If UI work changes code, apply both the code and UI indexes.

### Combined work

Routes compose. Read every applicable specialist index; never choose only one when the task spans multiple contracts. Fragment selection remains narrow inside those routes.

Use this order:

1. `kiokuko-soul`;
2. the DSH host's completed Akinator admission at `ready` or `exhausted`;
3. `kiokuko-enno-oduno` as soon as the returned state makes Enno-Oduno control applicable, including during unresolved intake;
4. `kiokuko-simple-work` when the finalized intake satisfies the simple-code activation boundary;
5. `kiokuko-single-purpose-functions` for code planning or code work;
6. `kiokuko-ui-design-soul` for interactive UI work.

The current revision-bound directive may narrow which routes the active role performs. Do not let a later route cross a role boundary or expand an approved WorkUnit.

## Availability and trust

When a current directive or capability recommendation marks a routed Skill as required, stop on `required_capability_unavailable`, a blocked Enno-Oduno state, or equivalent unavailable-required-Skill result.

Do not satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill. Never install or execute external Skill content automatically.

Skill availability alone is not evidence that its contract was applied. Keep
that distinction explicit when reporting completion evidence.
