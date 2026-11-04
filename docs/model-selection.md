# Execution and model selection

For each new build, debug, review or devops task, including README edits, the host
performs Akinator intake and runs normal execution. Chat and research/writing
tasks keep their ordinary flow. Continuations, retries and replanning retain the
logical task's identity. Cancel or skip preserves the request and any draft
configuration for resumption.

Normal execution uses the current DSH model, memory, applicable Skills, native
permissions and focused verification. It creates no separate contract, work-unit
plan, plan approval or automatic continuation.

## Automatic model selection

In Web profiles, [Kiokuko Models](kiokuko-models.md) manages connections without requiring DSH's Models settings. Its registered models are available to ordinary chat and Deep alongside native connections.

`modelAutoMode` is off by default in both the full plugin and modular core. To try it, authenticate Codex through Kiokuko Models or dsh-codex in the same DSH profile, configure a Jev, Laya or [OpenAI typed-decision backend](typed-decisions.md#openai-credentials), then use `observe` before enabling automatic routing:

```yaml
modelAutoMode:
  mode: off # off | observe | auto
  preset: codex-luna-sol-v1
  budgetMs: 5000
```

```text
/kioku-model-auto observe
/kioku-model-auto status
/kioku-model-auto on
```

The initial preset offers `gpt-6-luna` at low, medium and high effort, plus `gpt-6-sol` at high effort. Up to four exact route bindings can be configured under `modelAutoMode.routes`; each has an `id` from `luna-low`, `luna-medium`, `luna-high`, `sol-high`, and a `binding` with `provider`, `model`, and `reasoningEffort`. These are route labels, so a registered Astra or other GPT model may be assigned explicitly. No new model ID is guessed or substituted. A candidate must have a validated Codex origin and Responses protocol, live model context and modality metadata, supported efforts, call-config validation and token meter. Both native `openai-codex` and Kiokuko-owned Codex routes qualify; an arbitrary provider name or OpenAI API connection does not. Fewer than two valid bindings skips classification.

For a new admitted normal task, Kiokuko sends the current task text, task type, attachment kinds, route IDs and rubric to the selected Jev, Laya or OpenAI backend. It does not send attachment bytes, full history or repository contents for this classification. One Choice result selects a route or abstains. The route is stored against the exact run and reused for continuations; an unknown in-flight decision after restart is retained without another classifier call. `observe` records a proposal but keeps the current model. A failed probe, missing metadata, unsupported effort, timeout, oversized input or abstention also keeps the current model. Cancellation, stale session identity and storage integrity failures stop the request. Dispatch authentication, quota and unavailable-model errors remain ordinary failures; no alternate model is retried automatically.

The status distinguishes the configured mode, readiness, proposal and selected binding from the model observed in a native `request/header`. The initial preset is a rubric, not a claim that it improves quality, elapsed time or subscription usage. Deep, children, chat, review continuation and protected Lisp execution retain their existing owners. Automatic escalation after a failed implementation pass is not enabled.

### Routing evaluation and decision cache

From a source checkout, run the offline routing contract check without credentials or provider calls:

```text
npm run test:evaluation:model-routing
```

To measure how a configured Jev or Laya classifier handles the same 16 fixed Japanese/English cases, explicitly opt in to live requests:

```text
npm run test:evaluation:model-routing -- --live --provider jev --config PATH
npm run test:evaluation:model-routing -- --live --provider laya --config PATH
```

`PATH` is a JSON file in the `typedDecisions` configuration shape. Jev requires a versioned `typesafe.model` and `TYPESAFE_API_KEY`; Laya uses an already running worker. Live evaluation makes classifier requests, including a readiness probe, but never starts a generation turn or changes the active session model. Optional `--repetitions 1..10` (default 1), `--seed UINT32` (default 0), and `--output PATH` control repeatable JSON reporting. Offline output checks the evaluation pipeline and reports `quality: null`. Live results compare fixed cases with the current rubric; they do not establish model capability, real-work quality, cost, or provider cache savings. Laya v1 input completeness remains unverified.

The shared decision service keeps at most 256 completed request bindings and 256 completed results in memory when it can reload them from persistent storage. It does not delete stored decisions. This applies to decisions used by normal execution and Lisp `kioku.decisions:*`; automatic model routing and this evaluation remain specific to normal execution.

Option question cards accept **Cmd+1–9** shortcuts on macOS or **Ctrl+1–9** on
Windows/Linux, then Enter to confirm. With the card focused, typing an option
number and pressing Enter also submits. For options above nine, type consecutive
digits (`1`, `2`, Enter selects option 12); Backspace corrects the number. Digits
typed into a search field remain search text, and Enter submits the search. IME
composition and repeated key events do not select or submit.

## Head/worker model pairs

Tasks start in normal execution. In Web, open **Settings → Kiokuko Models** to
choose a **GPT-6.1-Sol head + DeepSeek V4.1 Flash subagent** pair for the current
chat or as the default for new chats. Saving the pair validates both exact model
IDs against the live catalog. The host binds each request to its resolved
selection and also supports pairs saved with earlier runs.

OpenAI assignments follow the [OpenAI model guide](https://developers.openai.com/api/docs/models):
**gpt-6.1-sol** as the head and **gpt-6.1-luna**/DeepSeek **V4.1 Flash** as the
worker, matching dsh-codex registration IDs when using a Codex connection. Exact
provider/model IDs are passed to the native adapter; display names never
authorize substitutions.

DSH owns provider authentication, transport and model validation. Authentication,
quota and unavailable-model failures retain completed work and require reselection
rather than automatic fallback.

## Persisted selection and recovery

Resolved configuration and the ordinary model are persisted per logical run.
The configured execution owner binds run ownership to one `mode` and rejects
conflicting ownership. A pending legacy execution selection becomes ready in
normal mode on admission.

Native tests cover request model IDs, ordinary README completion, task
cancellation and reload, input recovery, independent sessions, routing
restoration and adapter transport. Recording adapters do not verify paid
account access, subscription limits or successful live provider responses.
