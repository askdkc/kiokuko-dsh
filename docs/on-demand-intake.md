# Conversation-first intake (default)

Conversation-first, on-demand intake is the default. No activation setting is needed for the bundled native host, `createDshHostAdapter`, or `mountCore`; a modular Enno host inherits the core setting. Existing saved configurations that omit `intakeMode` receive this default when loaded. The packaged bundle intentionally needs no new field.

```ts
await mountCore(context, {
  // Existing model, repository and decision-provider settings are enough.
  // Omitting intakeMode selects conversation-first intake.
})
```

An explicit `intakeMode: 'eager'` retains upfront preparation for known intent. Native adapters now hand classifier abstention, failure or rejected input to ordinary model reasoning instead of asking the generic task-category question. The original request is retained; effects still require `prepare_requested_work` and the existing host checks. Disabling typed decisions retains the legacy deterministic intake path. Unknown mode values are rejected.

A separately supplied custom execution host can use the exported `createDshHostAdapter`, or must implement the same native `onDemandIntake` ownership contract; it cannot be safely synthesized from a tool list. Unsupported custom execution hosts fail with an actionable error rather than silently reverting to upfront questions. They may be updated or deliberately configured with the legacy eager opt-out. Prompt/Skill-only custom hosts own no execution ingress and remain supported.

## Conversation before execution

The native model receives the complete original user messages and may answer or ask a concrete clarification without opening Akinator's generic purpose question. The initial answer path does not fabricate a chat profile, ready intake, active ledger run, or completed task. Laya's result is provisional intent only; an abstention does not prevent conversation. A queued human request after a normal turn is classified independently rather than inheriting that stale turn's execution readiness. Existing Enno continuations retain their owner and original execution path.

Research, writing and action requests remain work requests. The host guidance tells the assistant to prepare requested tool-backed work rather than silently substitute a text answer or claim unperformed work.

## Memory, instructions, and recording

Ordinary answers retain the native conversation and its provenance, the system/SOUL instructions, and relevant installed model-invocable Skill instructions selected through the existing catalog/selector. They also receive bounded scoped memory through the existing broker and untrusted projections: core retains project-only recall, while the full host retains its federated scope and applicability checks. No execution intake, context-delivery receipt, or completed-work record is invented for this retrieval.

Owned memory snapshots are revalidated and deduplicated against native history. Forgotten entries, revised source material, and invalidated derived facts are removed from the active context; a change after assembly blocks that stale request at the final provider seam. Native user messages, unrelated instructions, and the on-disk audit history are preserved.

Configured memory-index reasoning still admits the actual native conversation/model through a verified session-workspace binding. It can generate the same indexed facts and cited bridges without a fake execution run. Its configured active/observe/off behavior remains in force. Run-bound memory application, execution verification, and post-task finalization begin when actual work is prepared. Native recording, including the bundled AgenticReplay configuration, remains enabled as configured.

Module `beforeTask` preparation hooks remain work-preparation hooks; they are not invoked merely to answer a question. Relevant read-only Skill instructions are selected separately so this does not require activating Lisp or opening task-purpose UI.

## Preparing requested work

In native tool presentation, the public `prepare_requested_work` tool accepts exactly one field:

```json
{"taskType":"research"}
```

Allowed types are build, debug, research, review, devops, writing and analysis. The type is advisory. The tool accepts no replacement task, target, expected result, constraints, permissions, or approval. The original native message batch and request identity are retained. The existing intake, coding-mode, memory, execution-selection, and native permission paths then run normally.

A native tool demand may also lazily prepare work using an already resolved provisional action type. When that type is absent or chat, exact native web_search and web_fetch demands use research as advisory input to the same host preparation. The original request and classifier result are preserved; tool arguments never supply a replacement target. Preparation continues the same call once, without an explicit preparation tool call or model retry. Other tools still require a resolved action type or explicit preparation. Tool names select advice only and grant no permission. No tool body is admitted until preparation has succeeded for that exact native agent, session and turn. Native deny/ask/monotonic guard decisions are not replaced with allow. A native cancellation is normalized to denial for compatibility with older runtimes that do not recognize a cancel policy result.

Known bare action references such as “Delete that” and “それを消して？”, bare search references such as “search that” and “それを検索して”, and known unresolved choices cannot acquire a concrete target merely from a type hint. Preparation returns targeted clarification guidance before a task is created. These are deliberately narrow missing-scope checks, not a general natural-language authorization system.

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

## Permission boundary

This feature separates conversational admission from execution preparation. It does not create a new universal semantic authorization policy. Native DSH pre-policy, approval, sandbox, and existing Kiokuko state/lease/path/memory guards remain authoritative. The native schema does not provide a general trusted effect classification or reusable user-action-scope receipt. A classifier label, a preparation hint, the current directory, and tool availability are never presented as new permission.

Native-loop tests use the published pinned DSH runtimes with scripted generation to verify this protocol. Such tests establish routing and enforcement behavior; they do not establish language-model intent quality. Real-Laya classification verification is a separate test layer.
