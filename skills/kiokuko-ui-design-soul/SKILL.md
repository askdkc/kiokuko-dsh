---
name: kiokuko-ui-design-soul
description: Use for user-facing interface work — design, implementation, or review — so every action stays discoverable, operable, recoverable, and accessible. Read only the expert fragments the interaction risks select.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design soul router

## Outcome

Make every interactive action discoverable, operable, perceivable, recoverable, accessible, and coherent across supported sizes and input methods.

Covers Web, desktop, mobile, touch, keyboard, screen-reader, form, navigation, async, destructive, permission, and other user-facing interaction work; not backend-only work. This is the compact UI index: read it completely, then read only the expert fragments selected for the current component, flow, design decision, or WorkUnit.

## Universal core

For new or behaviorally changed interactive actions, an action is complete only when the user can:

1. discover and understand it;
2. activate it comfortably;
3. perceive immediate acknowledgement;
4. understand processing, success, and failure;
5. recover without losing work or context;
6. continue through keyboard, touch, pointer, and assistive technology as applicable.

For purely visual changes, verify the affected appearance, layout, and accessibility properties, and expand into action-state behavior only when the change can affect it — a target size or a focus ring, for example.

Invisible work is a UI failure, so every reachable state needs defined behavior:

```text
idle -> pressed -> processing -> success | failure | cancelled
```

Add offline, permission-denied, empty, stale, and recovered states when reachable. Preserve input, selection, focus, scroll, navigation, and completed work through failure and rerender, and prevent duplicate and stale actions. Prefer native or semantic controls and the existing product design system. Respect Reduced Motion. Apply platform conventions and WCAG 2.2 requirements; do not imitate another vendor's visuals.

When requirements compete, prioritize safety and data preservation, accessibility, interaction correctness, user context, platform familiarity, performance, visual refinement, then decoration.

## Expert selection

Select one dominant expert for each UI component or cohesive flow, add at most two more only when the same WorkUnit genuinely crosses those risks, and record a concrete reason for each. On an Enno-Oduno `ui` route the WorkUnit also carries `code.*` expertise, because UI behavior is code behavior; sibling `test`, `docs`, and `operations` units inherit neither.

Do not read every UI reference “for completeness.” If implementation exposes a new risk, return the WorkUnit for an explicit selection or update the non-Enno working plan before reading the additional fragment.

## Expert index

| Expert ID | Select for | Read |
| --- | --- | --- |
| `ui.interaction.v1` | controls, feedback, targets, success, perceived responsiveness | [interaction-feedback.md](references/interaction-feedback.md) |
| `ui.async.v1` | loading, progress, retry, cancellation, concurrency, offline | [async-recovery.md](references/async-recovery.md) |
| `ui.forms.v1` | forms, validation, uploads, labels, disabled or empty states | [forms-and-controls.md](references/forms-and-controls.md) |
| `ui.accessibility.v1` | keyboard, focus, semantics, screen readers, contrast, motion | [accessibility-and-navigation.md](references/accessibility-and-navigation.md) |
| `ui.layout.v1` | responsive layout, zoom, content growth, platform adaptation | [responsive-and-platform.md](references/responsive-and-platform.md) |
| `ui.safety.v1` | destructive actions, permissions, user-work preservation, severity review | [safety-and-review.md](references/safety-and-review.md) |

Typical pairs: async Save button → `ui.interaction.v1` + `ui.async.v1`; validated settings form → `ui.forms.v1` + `ui.accessibility.v1`; delete flow → `ui.safety.v1` + `ui.interaction.v1`.

## Verification

For new or behaviorally changed actions, do not review screenshots alone: trace the affected activation, processing, success, failure, recovery, focus, and responsive behavior. For purely visual changes, use focused visual and accessibility checks. Read [ui-checklist.md](references/ui-checklist.md) for detailed review or final verification of affected interactions — a change crossing several `ui.*` risks, or the last check before accepting — not for a single visible change inside one expert's contract.

Report what was exercised in a running interface, what was inferred from source, and what remains unverified. A build, an API success, or a good screenshot alone does not prove UI correctness.
