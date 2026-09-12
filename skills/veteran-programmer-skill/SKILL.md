---
name: veteran-programmer-skill
description: Check workflow completeness before and after implementation when changes span setup, delivery, persisted state, or runtime handoffs.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: veteran-programmer-skill -->

# Workflow completeness

Ensure the requested behavior reaches its actual consumer. A correct component
can still leave the user's workflow broken at an unimplemented handoff.

Apply both checks below to changes involving multiple stages or lifecycle paths.
Keep the check proportional: a short trace may suffice. A wording-only edit or
isolated computation needs no system-wide audit. Inspect only relevant paths;
this Skill complements function-level design and verification.

## Before implementation

- Define the user's observable completion condition and the authorized scope.
  Trace backward from that outcome and forward from the real entry point;
  reconcile the two into a brief flow using current callers and artifacts.
- At each handoff, identify who produces what, who consumes it, what triggers
  the next step, and which identity, location, version or process must match.
  Include generated instructions, packaging, registration, deployed copies and
  reload timing when they participate in the requested behavior.
- Check the applicable lifecycle paths: first use, existing-state update,
  ordinary use, recovery after interruption or retry, and any termination or
  cleanup the change owns. Look for a missing
  caller, excluded variant, stale copy, or step that nobody owns. Follow actual
  branches rather than inventing a checklist of every possible failure.
- Decide what evidence would expose a broken handoff and prove the outcome.
  Record unresolved dependencies and permission boundaries; resolve material
  implementation choices from available evidence before asking the user.

## After implementation, before reporting completion

- Retrace the actual flow against the initial completion condition, including
  steps outside the edited files. Confirm each required producer has a reachable
  consumer and that both agree on the trigger, identity and artifact.
- Exercise the relevant user entry point and inspect its downstream result.
  Reuse existing evidence where sufficient; add focused regression coverage for
  a missing handoff or lifecycle branch, not tests of the checklist's wording.
- Distinguish source correctness, packaged content, deployed state and active
  runtime behavior. A build or helper test proves only its own layer. When a
  fixture substitutes for the live path, state exactly what remains unverified.
- Complete missing work within the authorized scope, then recheck affected
  paths. Do not stop at the first implementation or passing local test while a
  required step remains. If completion requires unavailable access or an
  unapproved external action, finish independent work and report the exact
  remaining action without claiming the end-to-end outcome.

For a review-only request, report omissions without editing the implementation.

## Completion evidence

Briefly report the flow checked, omissions repaired, evidence of the consumer's
result, and any remaining activation or verification step. Do not claim "no
omissions" beyond the paths inspected. This Skill grants no permission to
publish, deploy, broaden filesystem access, or bypass host-owned execution.

Design basis: [OpenAI's guidance on skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).
The checks above define the outcome and decision boundaries; choose the tools
and level of detail appropriate to the task.
