# Request clarification audit

The host must reuse facts bound to the current request before asking the human
to supply them again. A missing classifier result is not evidence that the user
omitted those facts. This rule does not turn a request interpretation, directory,
or task metadata into execution permission.

## Repairs

| Entry | Lost information | Repair | Regression coverage |
| --- | --- | --- | --- |
| Adapter and Core preparation | Selected working directory | Share the target default for resolved native work; preserve explicit targets and unresolved intent | `akinator-workspace-target-native.test.ts`, `akinator-gate.test.ts`, `core-tasks.test.ts` |
| Explicit task creation | Repository already bound to the native session | Store the selected repository with the new task; creating a task still leaves it ToDo | `task-workflow-host.test.ts` |
| Existing task intake | Current interpreted action and bound repository | Fill only missing category/target fields from the validated continuation | `existing-task-intake.test.ts` |
| Completion inference | Same-task clarification supplied by the host | Send bounded evidence with the original request and require a supporting quote from those sources | `akinator-answers.test.ts` |
| Adapter task resume | Main model, decision service, and latest request | Forward them to the existing-task intake, as Core does; keep identity, revision, and capability checks | `existing-task-admission.test.ts` |
| Legacy Lisp preparation | Already interpreted action | Reuse the action's task type before asking for a category | `akinator-coding.test.ts` |

The regression tests first exposed the unwanted target/category questions or
the dropped completion evidence. Native tests exercise both host paths and a
saved incomplete task. Model responses are scripted; these tests verify context
delivery and routing, not live model language quality.

## Other question producers inspected

| Producer | Question contract retained |
| --- | --- |
| `on-demand-intake.ts` | Resolve a genuinely unknown target/action/change scope or an explicit task-state transition; existing source-bound clarification receipts suppress repeated answers. Ordinary main-model interpretations already tolerate auxiliary abstention. |
| `task-startup.ts` | Choose decision/Lisp settings once and reuse the same chat's immutable selection; cancellation and explicit overrides remain effective. |
| `coding-workflow/host.ts`, `lisp/surface.ts` | Reuse the task's Lisp choice or explicit manual preference; a merely enabled runtime does not constitute a new approval. |
| `agenticreplay-session-choice.ts` | Persist the session recording choice, rather than asking on every turn. |
| `owned-execution.ts` and Core/adapter confirmation handlers | Confirm protected destructive effects under the existing native policy. |
| `lisp/approval.ts`, `lisp/ci.ts` | Approve the displayed protected operation and recheck the target before execution. |
| `memory-application.ts` | Resolve a concrete conflict with an existing correction, deduplicated by request and source identity. |
| `repository-learning.ts`, `lifecycle-memory.ts` | Review the exact proposed memory before saving; a changed proposal requires its own approval. |

No cross-chat answer cache, inferred approval, phrase-based bypass, or automatic
task start is introduced. Existing ambiguous-request, stale/foreign-answer,
cancellation, capability-change, and task-ownership tests remain required.
