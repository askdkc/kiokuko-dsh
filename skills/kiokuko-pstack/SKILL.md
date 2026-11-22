---
name: kiokuko-pstack
description: Apply the pstack defect review, repair and CI loop alongside the active coding Skills during implementation.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-pstack -->

# pstack for DSH

Use this loop for an authorized code change. Keep the coding routine, single-purpose functions, completion Skill and applicable specialist guidance active. Use the execution route selected for this task.

1. Read the changed behavior through its callers. Identify a concrete input, boundary or failure sequence that could produce a user-visible regression. Try it through the normal entry point. For a reported bug, capture the original failing behavior.
2. Trace confirmed failures to the owning code. Add focused regression coverage when it can distinguish the fault. Make the smallest in-scope repair, repeat the original operation, and inspect the resulting diff for new defects. Keep unresolved hypotheses separate from confirmed failures.
3. Read the repository's verification entry point and CI job selection, including path and platform conditions. Run the applicable CI checks locally on the final working tree through the selected route. If the repository has no CI, run its documented checks and report that coverage. Use task_completion status and bind observable checks to the affected sources.
4. On failure, inspect the first relevant failing assertion or job log. Repair the cause, repeat the focused check, then rerun the affected CI checks. Continue while evidence supports another in-scope action. Preserve a concrete blocker if a prerequisite, permission or host limit prevents progress.
5. When a remote run exists for the exact revision under test, inspect its jobs and wait for pending required checks. Report the revision, actual checks and unresolved conditions. A dirty tree needs its own local evidence. Push, workflow dispatch and merge require authorization for those actions.

Adapted from the [pstack bug-fix playbook](https://github.com/cursor/plugins/blob/792440e8a560a4a3f63748cdee70491ecd412982/pstack/skills/poteto-mode/playbooks/bug-fix.md).
