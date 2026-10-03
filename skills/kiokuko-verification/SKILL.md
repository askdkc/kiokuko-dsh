---
name: kiokuko-verification
description: Create or maintain a project-specific recipe that exercises real user-visible behavior.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-verification -->

<!-- kiokuko:runtime contract -->
# Verification

Follow SOUL and the current host directive. This skill grants no extra permissions, model changes or delegation. Use the current model and proportionate evidence.

Inspect existing launch commands and test drivers before introducing tools. Define launch readiness, exercise steps, expected results, evidence, isolation and cleanup. Reuse the project test harness. Create a project-local verify skill only when requested; use the repository convention or .agents/skills/verify-<app>/SKILL.md. Never overwrite an unmanaged recipe.

## Completion

Maintain a feature map with entry points and repeatable recipes. Exercise each claimed covered feature. Distinguish doc drift from product regression; report the latter without rewriting expectations to hide it. Report clean, changed or blocked, plus coverage gaps. Cleanup only resources created by this verification.

Read [worked cases](references/cases.md) only when the decision or failure boundary is unclear. Do not load unrelated specialists or repeat completed checks without new evidence.
<!-- /kiokuko:runtime -->
