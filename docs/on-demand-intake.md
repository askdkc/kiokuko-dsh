# Conversation-first intake (default)

Conversation-first, on-demand intake is the default. No activation setting is needed for the bundled native host, `createDshHostAdapter`, or `mountCore`; a modular Enno host inherits the core setting. Existing saved configurations that omit `intakeMode` receive this default when loaded. The packaged bundle intentionally needs no new field.

```ts
await mountCore(context, {
  // Existing model, repository and decision-provider settings are enough.
  // Omitting intakeMode selects conversation-first intake.
})
```

An explicit `intakeMode: 'eager'` retains upfront preparation for known intent. Native adapters now hand classifier abstention, failure or rejected input to ordinary model reasoning instead of asking the generic task-category question. The original request is retained; explicitly prepared and owned effects still require their preparation and existing host checks. Ordinary native Bash remains on its native permission path, independently of optional preparation. Disabling typed decisions defers interpretation to the main model using the same source-bound contract. Unknown mode values are rejected.

A separately supplied custom execution host can use the exported `createDshHostAdapter`, or must implement the same native `onDemandIntake` ownership contract; it cannot be safely synthesized from a tool list. Unsupported custom execution hosts fail with an actionable error rather than silently reverting to upfront questions. They may be updated or deliberately configured with the legacy eager opt-out. Prompt/Skill-only custom hosts own no execution ingress and remain supported.

## Conversation before execution

The native model receives the complete original user messages and may answer or ask a concrete clarification without opening Akinator's generic purpose question. The initial answer path does not fabricate a chat profile, ready intake, active ledger run, or completed task. Laya's result is provisional intent only; an abstention does not prevent conversation. A queued human request after a normal turn is classified independently rather than inheriting that stale turn's execution readiness. Existing Enno continuations retain their owner and original execution path.

Research, writing and action requests remain work requests. The host guidance tells the assistant to prepare requested tool-backed work rather than silently substitute a text answer or claim unperformed work.

## Memory, instructions, and recording

Ordinary answers retain the native conversation and its provenance, the system/SOUL instructions, and relevant installed model-invocable Skill instructions selected through the existing catalog/selector. They also receive bounded scoped memory through the existing broker and untrusted projections: core retains project-only recall, while the full host retains its federated scope and applicability checks. No execution intake, context-delivery receipt, or completed-work record is invented for this retrieval.

Conversation and execution memory have distinct request owners. An old execution task cannot remove the current conversation snapshot. Owned memory snapshots are revalidated and deduplicated against native history. Forgotten entries, revised source material, and invalidated derived facts are removed from the active context; a change after assembly cancels stale dispatch and rebuilds once for the same logical request. A second conflict fails with a bounded diagnostic. Native user messages, unrelated instructions, and the on-disk audit history are preserved.

Configured memory-index reasoning still admits the actual native conversation/model through a verified session-workspace binding. It can generate the same indexed facts and cited bridges without a fake execution run. Its configured active/observe/off behavior remains in force. Run-bound memory application, execution verification, and post-task finalization begin when actual work is prepared. Native recording, including the bundled AgenticReplay configuration, remains enabled as configured.

Module `beforeTask` preparation hooks remain work-preparation hooks; they are not invoked merely to answer a question. Relevant read-only Skill instructions are selected separately so this does not require activating Lisp or opening task-purpose UI.

## Preparing requested work

The host supplies bounded references to current human input, the active Goal and preceding same-session proposals. Jev/Laya classifies the requested action, relation to active work and selected proposals. If interpretation is unresolved, the main model submits its interpretation through `prepare_requested_work`:

```json
{"taskType":"research","requestIntent":{"relation":"new","action":"research","evidenceRefs":["<current-host-reference>"]}}
```

An auxiliary semantic abstention asks the user about the current target, operation and constraints; it is neither permission nor a contradiction. For a concrete new/same-scope request, the native question quotes the unchanged request and offers explicit confirmation or correction. Only the affirmative native selection binds a private, session-local receipt to the exact source, answer bytes, candidate and current task/Goal/proposal revisions. After the answer is recaptured, the same candidate can record `user_confirmed` while the provider remains `insufficient`; the finite source checks and all existing admission/native permissions still run. Empty answers, dismissal, foreign or edited answers, changed scope and restart cannot recreate that receipt. Model-written approval fields or quoted answers cannot create it. Corrections are queued as native user input for fresh interpretation, not mapped to automatic permission. Proposal adoption, scope expansion, lifecycle operations, unknown targets and contradictions cannot use this confirmation shortcut.

The guidance separates mandatory `requiredReferences` (current message and active identity/revisions) from optional per-proposal `evidenceRef` values. Include only proposals the current request actually adopts or references; unrelated proposals are not implicit approvals. Unknown or stale references remain errors.

An abstention on the optional `taskOperation` question preserves independently resolved relation/action/scope and records `task_operation_unresolved`; it does not start, resume or complete a task. The main model can resolve that diagnostic with the exact current references. Pending/terminal state, stale leases, scope changes and native permissions still use their existing checks. Uncertain proposal references and unknown action/target still require resolution. A change also requires an explicit implementation or document scope at Core, adapter and on-demand preparation boundaries, including when taskOperation is omitted, none, or uncertain; a legacy task-type hint cannot supply that scope. Core also preserves the prior task at the next-turn admission boundary while required change scope remains unresolved. Explanation or inspection accompanying an explicit edit is classified as change without dropping the other requested work or prohibitions. This prompt rule is not evidence of live model accuracy.

Allowed types are build, debug, research, review, devops, writing and analysis. The type is advisory. The bound action distinguishes answer, research, verify and change; relation distinguishes new work, continuation and scope change. Preparation and execution consume the same interpretation. Unknown references, another request, stale Goal revisions and attempts to replace a definite provider interpretation are rejected. Continuing work preserves its Goal and choice; scope expansion requires a Goal revision. Repeating explicit preparation after automatic preparation acknowledges the existing receipt without creating another task. The tool accepts no replacement task, target, expected result, constraints, permissions, or approval. The original native message batch and request identity are retained. The existing intake, coding-mode, memory, execution-selection, and native permission paths then run normally.

A tool demand subject to preparation may also lazily prepare work using an already resolved provisional action type. The original request and classifier result are preserved; tool arguments never supply a replacement target. Preparation continues the same call once, without an explicit preparation tool call or model retry. Prepared/owned process execution requires its bound action; verification permits such execution, while direct writes require change intent. Ordinary root native Bash does not require an optional preparation round trip. Native read, glob, grep, web_search and web_fetch can gather evidence without committing a task interpretation, subject to unresolved-target and existing ownership checks. These native paths are not preparation receipts and do not authorize switching tools to evade a denied protected effect.

Exact registered native question implementations and the plugin's strict `coding_workflow {action:"status"}` call can remain conversational before preparation. Status only observes the current workflow; it does not project a new workflow, repair a blocker, or advance work. `next`, propose/revise, extra arguments, and replacement implementations do not inherit that status exception. Native permissions remain authoritative on every path. Tool names select advice only and grant no permission. Calls subject to preparation are not dispatched until preparation succeeds for the exact agent, session and turn. Native deny/ask/monotonic guard decisions are not replaced with allow; native cancellation is normalized to denial for older runtimes that do not recognize a cancel policy result.

Known bare action references such as “Delete that” and “それを消して？”, bare search references such as “search that” and “それを検索して”, and known unresolved choices cannot acquire a concrete target merely from a type hint. Preparation returns targeted clarification guidance before a task is created. These checks apply only when semantic interpretation is unresolved. The Japanese Skill instructs the model to resolve omitted subjects and shorthand from the supplied current context, preserving negation and distinguishing quoted proposals from human requests. Resolved work is not independently reinterpreted by host phrase matching.

## PTC presentation

Conversation entry and the preparation carrier preserve the configured PTC presentation. When only `run_code` is directly visible, this exact preparation-only carrier is supported:

```ts
return await tools.prepare_requested_work({"taskType":"research"})
```

Use a normal nonempty `description` alongside `code`. The optional final semicolon is accepted. The carrier must contain only the canonical call above with an allowed type as JSON; extra statements, expressions, alternate arguments, or extra `run_code` fields are rejected while unprepared.

The host intercepts this carrier after native pre-policy and before the PTC interpreter. Its result explicitly says that no program was evaluated. Once the original task is prepared, ordinary PTC execution and nested native tools retain their usual permissions, sandbox, and guards.

With PTC, pending memory-application decisions preserve DSH's `run_code` presentation and bound capability inventory. The model calls the existing review tool through the generated SDK, for example `return await tools.task_memory_review({ action: "status" })`. Unresolved decisions prevent successful completion but do not block prepared tool execution. Completing the review leaves the native PTC presentation unchanged.

A same-agent explicit `presentAs('ptc')` declaration combined with pending memory decisions remains unsupported: the native registry rejects a second presentation declaration in that scope. This fails closed rather than bypassing memory review or changing the user's owned presentation. PTC without pending memory decisions, and deployment-level PTC with review, are covered separately.

## Identity, recovery, and cancellation

- Current task text is snapshotted; changing a human message under the same ID invalidates the pending request.
- An advisory type cannot overwrite a prepared task or revive a closed turn.
- A new native turn cannot borrow an older turn's preparation.
- Existing unfinished execution owners remain on their existing recovery path. A reopened session can answer while a retired in-memory owner is detached; its durable task and obligations stay unchanged. Further work must recover that owner or fail closed. This does not make every unfinished execution automatically resumable.
- Validated native children retain their existing delegated ownership and permission enforcement.
- Cancellation, turn closure, changed instructions, and shutdown abort pending preparation and not-yet-started native dispatch. Shutdown drains preparation before closing the runtime.
- Unknown tool definitions and definition changes fail closed.

## Clarification instead of a terminal refusal

When explicit preparation still lacks a concrete target, action, relationship, change scope, or the user-selected transition needed for an inactive task, the host asks only for the missing detail through native `userQuestions`. A dismissed/unavailable question returns `prepared: false` and `awaiting_clarification`; it never starts work. Without the native question surface, the same result supplies a question for the conversation to ask once. The exact request/context/question is deduplicated, and a waiting clarification retains the prior task through normal completed/idle boundaries. Stop, cancellation and failed boundaries do not become approvals or suppress their lifecycle cleanup.

A matching, nonempty native UI answer is checked against the live agent/session and fresh task evidence, then queued as genuine human follow-up evidence. The original utterance is retained verbatim and labelled separately from the answer. No free-text answer is converted directly into a permission or state operation: the new turn must pass normal interpretation, exact-reference admission and native permissions before any effect. Changed task evidence while waiting returns `clarification_context_changed` with current references instead of reusing the stale answer. Explicit security/native permission denial is not converted into approval.

An accepted answer returns `clarification_answer_queued`, its exact `answerRef`, and `nextAction: await_queued_answer_capture`; it is no longer waiting for another user answer. Repeated preparation returns the same linkage without another question or follow-up. Continue only after native capture supplies fresh references. An unavailable independent assessment instead returns `assessment_unavailable`, `preparedExecutionAllowed: false`, and `nextAction: report_assessment_unavailable`. It is neither a semantic clarification nor successful preparation: report the missing assessment, retain the request, and do not claim that another tool route repaired this boundary. The bundled finite judge is currently native-verified on Apple Silicon macOS only; unsupported platforms remain unavailable rather than receiving a substitute proof.

In Core, native abort also requests the existing stop operation for a captured Working SQLite task that has no Core execution owner. The exact session, turn, task revision and generation are checked; an old question cannot stop a replacement generation. Stop receipts still require the existing process-drain evidence.

## Permission boundary

This feature separates conversational admission from execution preparation. It does not create a new universal semantic authorization policy. Native DSH pre-policy, approval, sandbox, and existing Kiokuko state/lease/path/memory guards remain authoritative. The native schema does not provide a general trusted effect classification or reusable user-action-scope receipt. A classifier label, a preparation hint, the current directory, and tool availability are never presented as new permission.

Native-loop tests use the published pinned DSH runtimes with scripted generation to verify this protocol. Such tests establish routing and enforcement behavior; they do not establish language-model intent quality. Real-Laya classification verification is a separate test layer.

`npm run test:evaluation:request-intent` checks the synthetic evaluation pipeline for Japanese shorthand, negation, quotation, plan-only requests and English continuation. Its offline oracle supplies declared gold answers and does not measure language understanding. Use `npm run test:evaluation:request-intent -- --live --config /absolute/path/decisions.json` to evaluate the explicitly selected Jev, Nimble or Laya configuration through the production decision service. The file follows `TypedDecisionsConfig`; credentials remain in the provider's named environment variable. No provider is substituted. Missing explicit configuration or a Jev credential returns `unmeasured` without a model call. Live failures and abstentions remain visible in the report; synthetic accuracy does not establish production quality.

## Recording diagnostics

AgenticReplay remains a model/tool observation capture with `httpCapture:false`. The request observer wraps final native guards so a pre-provider failure remains visible. Failed request projection never emits an orphan response. Capture limits stop recording without affecting native execution; the index and bounded `runs/<runId>/capture-status.json` retain the missing-event count and first failure code independently of the stopped event queue. Native turn failures and bounded memory-fence codes are recorded without private exception text. A failed filesystem cannot guarantee a diagnostic file; status reports persistence failure in that case. Historical traces lacking diagnostics cannot retrospectively establish why capture stopped.
