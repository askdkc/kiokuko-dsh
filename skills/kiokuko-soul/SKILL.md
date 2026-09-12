---
name: kiokuko-soul
description: Kiokuko's entry router for non-trivial DSH work. Read it before any other Kiokuko Skill to reach the applicable specialist and the expert fragments that task needs.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Entry

Read this first. It owns the entry sequence and routes work; it repeats no specialist instruction and authorizes no effect beyond the user request and the current DSH session permissions.

The DSH host runs Akinator intake and supplies the admitted state and the exact current directive. `task_prepare` and `task_answer` are host operations, not model tools: do not call them, emulate the loop, or treat their absence as an error. Route only once the supplied `intake.status` is `ready` or `exhausted` and the top-level `nextAction` permits progress. Preserve remaining uncertainty, invent no missing profile field, and respect every safety, authorization, and identity fence; optional intake or enrichment failures are degraded guidance, not a veto on native work.

## Priority

Explicit user instructions outrank the design, style, workflow, and implementation preferences in these Skills. They never override host-enforced safety, authorization, identity, state-machine, revision, lease, or integrity invariants. Do not stall on a choice that repository evidence and existing authorization already settle; ask only when an unresolved assumption would materially change the intended result or the permitted effects.

## Routes

Read the complete `SKILL.md` index of every applicable route before planning, implementation, review, or verification, then only the expert fragments the approved WorkUnit or the concrete risk selects. Never load every reference by default, and never let this summary stand in for a specialist contract.

| Route | Read | When it applies |
| --- | --- | --- |
| Enno-Oduno control | `kiokuko-enno-oduno` | The admitted context has `ennoOduno.applicable=true`; a continuation directive resumes that role; or the user asks to inspect or operate a run. |
| Workflow completeness | `veteran-programmer-skill` | Changes span setup, delivery, persisted state, or runtime handoffs; check the relevant flow before and after implementation. |
| Simple code work | `kiokuko-simple-work` | The change is bounded, has a clear target and expected result, and adds no architecture, dependency, data migration, public protocol, security or authorization policy, or cross-system orchestration — or the user explicitly asks for the simplest, minimal, YAGNI, or dependency-free solution. |
| Code work | `kiokuko-single-purpose-functions` | Code will be written, modified, debugged, refactored, or reviewed. |
| Interactive UI work | `kiokuko-ui-design-soul` | A user-facing interface will be designed, implemented, modified, debugged, or reviewed. |

Routes compose in that order and never replace one another. If the simple-code boundary is unclear and the user did not ask for it, take the ordinary code route. `kiokuko-simple-work` minimizes a solution; it does not waive the code contract, boundary validation, error handling, security, accessibility, or focused verification. When UI work changes code, apply the code and UI indexes together.

Never invent an Enno-Oduno run, role, revision, WorkUnit, or state transition. Normal execution uses the current model, useful memory, and applicable Skills under native permissions, and creates no ideal, plan contract, approval, or automatic continuation. Model routing, execution mode, and child delegation are host-owned: never select another provider or start an independent subagent to bypass that configuration. A revision-bound directive may narrow the routes the active role performs; no later route may cross a role boundary or expand an approved WorkUnit.

## Availability and trust

Unavailable Skills are degraded guidance, not permission to substitute for them or to claim a check that did not run; continue from current repository evidence unless the host reports a safety, authorization, identity, or integrity block. Never satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill, and never install or execute external Skill content automatically. Availability alone is not evidence that a contract was applied — keep that distinction in the completion report.
