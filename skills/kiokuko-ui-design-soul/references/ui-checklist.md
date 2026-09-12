<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design and review checklist

Last reviewed against the official sources: 2026-08-22.

This checklist paraphrases decision principles. It does not reproduce Apple text or require Apple-styled visuals.

Read this file for detailed implementation review or final verification of affected interactions. For a single visible change inside one expert's contract, the selected `ui.*` fragment and its universal-core checks are sufficient.

## Required GUI and CLI interaction checks

Apply these requirements to graphical interfaces and command-line interfaces alike:

- **Visible choices:** show the available, task-relevant choices whenever practical. Do not require users to guess valid values or memorize identifiers when the application already knows the options. Group, filter, search, or paginate large sets so choices remain discoverable.
- **Easy selection:** provide suitable shortcuts, numbered menus, or checkbox lists instead of unnecessary free-text entry. Show the relevant keys or gestures beside the choices. Distinguish single selection from multiple selection, make the current selection visible, and make confirmation and cancellation clear. For interactive CLIs, use number keys or arrow navigation, Space to toggle, and Enter to confirm where appropriate.
- **Visible progress and state:** acknowledge the action promptly and show intermediate status during slow work. Display measured progress when available; otherwise show the current phase or an honest activity indicator. Make completion, failure, cancellation, and stalled work distinguishable; do not leave users guessing whether processing has started or finished.
- **Useful error causes:** display what failed, its known cause, and the next available recovery action. A generic failure message, error code, or log entry alone is insufficient when the cause is known. If the cause is unknown, say so and give a useful diagnostic next step rather than inventing an explanation. Keep secrets out of messages.

For non-interactive CLI use, keep explicit flags or input formats available instead of forcing a prompt. Preserve the command's output contract: progress and diagnostics must not corrupt machine-readable output; use the documented diagnostic channel, typically stderr, and disable terminal animation when no TTY is available.

## Eight-principle map

| Principle | Practical question |
| --- | --- |
| Purpose | Does every important element help the user complete the primary task? |
| Agency | Can the user understand, initiate, interrupt where safe, and recover from actions? |
| Responsibility | Does the interface protect privacy, attention, safety, and user-created work? |
| Familiarity | Do labels, controls, navigation, and feedback follow the target platform's conventions? |
| Flexibility | Does the flow adapt to ability, input method, device, content size, and context? |
| Simplicity | Is the next meaningful action clear without hiding necessary information or control? |
| Craft | Are states, spacing, copy, timing, focus, and edge cases implemented consistently? |
| Delight | Does successful, calm, recoverable use feel better because the details work together? |

## State coverage

For each primary action, verify the applicable states:

- **Actionable:** the label predicts the result; enabled and disabled states are distinguishable without color alone.
- **Pressed and focused:** feedback is immediate; keyboard focus is visible; focus order follows the task.
- **Processing:** status remains near the initiating control; duplicate submission is prevented without trapping the user.
- **Progress:** measurable work uses a determinate value; unmeasurable work uses an indeterminate indicator and an accessible status message.
- **Long or stalled work:** expectations are updated; a reason and next step are shown; cancellation is available only when it is safe and real.
- **Success:** completion is perceivable visually and programmatically; the interface moves focus only when that helps the next task.
- **Empty:** the state explains what is absent and offers a relevant next action rather than presenting a dead end.
- **Failure:** input and completed work are retained; the message says what happened in actionable language; retry, undo, or back is available where meaningful.
- **Offline:** unavailable behavior is explicit; queued or local work is not implied unless it is actually preserved.
- **Permission denied:** explain the missing capability and provide a safe route to settings, an alternative, or back.
- **Destructive:** communicate scope and consequence; prefer undo for reversible actions and use explicit confirmation for material irreversible harm.
- **Recovered:** clear stale errors and busy states; restore a coherent focus position; avoid re-running the action unexpectedly.

## Accessibility and adaptation

- Use semantic HTML or native controls before recreating their behavior.
- Verify the full primary flow with keyboard only, including visible focus and escape from overlays.
- Verify names, roles, values, errors, progress, and status announcements with a screen reader.
- Test touch, pointer, keyboard, and relevant alternate input; do not require hover, precise pointing, or a single gesture.
- Test narrow and wide layouts, zoom or text resizing, longer translated copy, and dynamic content.
- Do not encode meaning with color, motion, shape, or sound alone.
- Respect Reduced Motion and provide equivalent state information without animation.
- Keep time limits adjustable or avoid them unless the task itself requires one.
- On the web, apply the existing design system and WCAG 2.2; do not imitate iOS merely because these principles originated in Apple HIG.

For an asynchronous action, run the `ui.async.v1` state, processing, and recovery contract in [async-recovery.md](async-recovery.md) against the flow.

## Official sources

- Apple Human Interface Guidelines — Design principles: https://developer.apple.com/design/human-interface-guidelines/design-principles
- Apple Human Interface Guidelines — Buttons: https://developer.apple.com/design/human-interface-guidelines/buttons
- Apple Human Interface Guidelines — Loading: https://developer.apple.com/design/human-interface-guidelines/loading
- Apple Human Interface Guidelines — Progress indicators: https://developer.apple.com/design/human-interface-guidelines/progress-indicators
- Apple Human Interface Guidelines — Feedback: https://developer.apple.com/design/human-interface-guidelines/feedback
- Apple Human Interface Guidelines — Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Apple Human Interface Guidelines — Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- W3C Web Content Accessibility Guidelines 2.2: https://www.w3.org/TR/WCAG22/
