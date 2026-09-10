# Deep planning verification

Local verification on 2026-09-10 used Node 24.16.0 on macOS and the published
DSH 0.1.5-rc.1 dependency graph, including agent, agent-loop, commands, llm,
session, system-prompt, tools, subagent and subagent-spawn-in-process.
Cordis resolved to 4.0.2. This is an uncommitted implementation based on
`b6c58fc77459c2f52763f6e28a809777c53773f2`; it is not a published release or
evidence of a GitHub CI run.

## Automated checks

- Full repository test command: 427 passed, zero failed or skipped.
- Type checking and production build passed.
- Native tests exercise command IDs, input claim before system-prompt assembly,
  initial child binding, tool restrictions, actual stream reservations, memory
  without a parent model turn, generic file rejection, cancellation and unload.
- Deterministic scheduler/store tests cover nested aggregation at concurrency
  one, concurrent leaves, local replanning, process ownership, stale revisions,
  source changes, uncertain calls, recovery and zero-budget partial answers.
- Package lifecycle tests use a disposable profile and require native test
  collection. They record resolved dependency versions and test installation,
  authenticated report/export HTTP routes, browser bundle loading, server
  restart, removal and restoration of the stock Session export plugin.

## Visible Web checks

A separate disposable profile used a local recording adapter with no external
model calls. The actual installed plugin was exercised through the Web UI:

- A current Web model selection initializes all four roles without an extra
  model-selection prompt.
- A completed answer and its memory status survive opening a Session created
  under 0.1.2-rc.1 in 0.1.5-rc.1.
- Closing and reopening configuration retains a submitted zero-token draft.
- Zero budget produces a visible partial answer, zero model requests, the stop
  reason, unresolved requirements and an explicit memory-skipped status.
- Rendering saved answers acknowledges the exact report IDs in persistence.
- Escape closes the answer dialog and returns focus to its opener. Tab stays
  within the native modal dialog; long answers are outside live regions.
- At 390 CSS pixels wide, long code wraps inside the dialog without horizontal
  overflow. Browser zoom itself was not verified: the available embedded
  browser did not change its zoom in response to keyboard zoom shortcuts.

## Compatibility decisions discovered during verification

Both tested DSH versions omit the external-event `ignorable` option when
appending a Session event. Deep reports therefore remain in its own durable
outbox and use an authenticated, Session-bound HTTP view with explicit receipt
acknowledgement. They do not introduce unrecognized native log events.

DSH 0.1.5-rc.1 requires `requestBody: 'buffered'` for these exact GET routes.
Without it, its HTTP bridge tries to construct a GET request with a streaming
body and returns 400 before reaching the plugin. Both Deep reports and the
existing Session export route now specify their body mode. The acknowledgement
origin check uses the preserved Host header because the bridge's internal
Request URL uses `dsh.internal`.

V3 Session events embed the assistant stream and no longer use the V2 assistant
chunk-reference representation. Native assertions validate the complete text
and the actual version's representation, without manufacturing legacy events.

These fixtures establish integration and recovery behavior. They do not
establish live-provider answer quality, lower cost, faster completion or
equivalence across models. Provider-internal retries remain outside observable
request accounting, and token admission remains an explicit estimate.
