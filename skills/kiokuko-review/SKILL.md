---
name: kiokuko-review
description: Review a diff, assess blast radius, or challenge code with concrete counterexamples.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-review -->

<!-- kiokuko:runtime contract -->
# Review

Follow SOUL and the current host directive. This skill grants no extra permissions, model changes or delegation. Use the current model and proportionate evidence.

Identify the exact diff and intended behavior. Trace changed producers through consumers, failure paths and shared state. Try a concrete counterexample to each material correctness claim. Preserve useful rationale, legal notices and constraint comments; uncertainty is a reason to investigate, not delete. Review alone does not authorize edits.

## Completion

Report location, trigger, consequence and evidence for each defect. Separate defects from optional style suggestions. Deduplicate findings. Passing builds and reviewer agreement are not behavioral proof. State unverified paths and missing coverage.

Read [worked cases](references/cases.md) only when the decision or failure boundary is unclear. Do not load unrelated specialists or repeat completed checks without new evidence.
<!-- /kiokuko:runtime -->
