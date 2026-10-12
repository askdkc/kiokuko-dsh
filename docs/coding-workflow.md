# Goal-driven coding in DSH

An explicit request to implement or repair code starts a task-bound workflow. Questions, explanations, quotations, undecided alternatives and plan-only requests retain the conversation/read-only path. Classification is advisory and cannot authorize an unrequested change.

Before the first implementation effect the agent defines an ideal Goal, implementation items and dependencies, observable item criteria, and a separate final check through the user's ordinary entry point. The host presents these together and asks **このタスクで Lisp モードを使いますか？**

- **使う** permits Lisp for this task. SBCL and the enabled Lisp module must be available. Startup failures remain visible blockers.
- **使わない** uses ordinary tools and the same completion conditions. SBCL is unnecessary.
- **取消・作業を保持** cancels dispatch while preserving definitions and existing results.

Closing, an empty answer, a disconnected client or missing question service leaves the choice pending. Conversation, reads and status remain available. `coding_workflow next` reopens the same pending question. A new task or material scope change gets a new question. Existing Lisp runtime/approval settings never answer it. Manual `/kioku-lisp enable`, `enable-task` or `disable` changes an already defined current task explicitly, invalidating its old evidence; it cannot bypass an undefined Goal.

After the choice, the agent follows dependency-ready items without another approval at every step. Existing Plan, native goal/ownership and destructive-effect approval rules still apply. Normal/Enno selection remains separate from Lisp selection. Enno projects its authoritative ideal, WorkUnits and focused/final verifiers into the common view; it cannot submit a competing Goal.

## Model-facing API

`coding_workflow` exposes `status` and `next`; status includes the current revision, a complete `minimumValidInput` example and the next safe action. `coding_workflow_apply` accepts `propose` or `revise`, with required `expectedRevision` and `definition`. `coding_workflow_blocker` requires `expectedRevision` and `blocker`. The legacy propose/revise/report_blocker actions remain accepted on `coding_workflow`. The published schemas and execution use the same required fields. Put constraints in `definition.goal.constraints`; goal, item and criterion IDs must be unique across the entire definition. Final Goal criteria must be separate from item criteria. A stale revision or invalid field returns its correction. These operations cannot write Lisp answers or satisfied verdicts.

Preparation, continuation and execution consume the same source-bound `requestIntent`. Jev/Laya receives the current request, the active Goal and bounded same-session proposals; its finite decisions include the selected proposal references. On abstention or failure the main model resolves that context through `prepare_requested_work`. Same-scope continuation preserves the Goal and Lisp choice. Scope changes block dispatch until a revised Goal is accepted. Verification permits native process checks without being reclassified as implementation; it does not authorize direct file changes or override native permissions.

The existing `task_completion status/bind` API exposes stable criterion IDs such as `coding:<workflowId>:regression`. Bind a verification method before executing it:

```json
{
  "action": "bind",
  "criterionId": "coding:<workflowId>:regression",
  "method": {
    "kind": "native_command",
    "command": "node --test --test-reporter=tap src/parser.test.mjs",
    "cwd": ".",
    "sourcePaths": ["src/parser.mjs", "src/parser.test.mjs"],
    "assertion": "selected_tests_pass"
  }
}
```

Run the bound command through `kioku_exec` or the selected Lisp process API. Their actual host process results enter the same evidence ledger. A native tool's self-reported JSON cannot mint host proof. Output assertions require `output_matches` with the exact literal `expectedOutput` (line endings and trailing whitespace are normalized); artifact assertions require `artifact_matches` with `artifactPath` and `artifactSha256`. Browser criteria use a bound selected test that drives a real browser and asserts visible outcomes.

All item checks must pass before a **new execution** of the final Goal check. Reusing an earlier item result cannot satisfy it. Related source paths, package/configuration/lockfiles, runtime identity, criterion revisions and scope determine freshness. Add generated/installed artifact paths to `sourcePaths` when they affect the behavior. No-op suites, zero explicit cases, skips, missing output, unsuccessful child processes, interruption and untrusted results remain unmet or unknown. A nonempty test case still needs meaningful assertions: the host cannot prove an arbitrary test's specification quality.

Completion is enforced for new coding workflows. Legacy runs without workflow records retain their previous completion mode and never acquire a fabricated Lisp choice. Incomplete coding runs remain active; cancellation/failure records are still permitted. Inspect `status` for what remains rather than trusting a final model sentence.

## Recovery and verification

Definitions, task answers, CAS revisions and replay receipts are durable. Exact retries return stored results; changed input under an existing call ID conflicts. Owned execution journals preserve operation identities and return unknown after a crash instead of repeating an uncertain effect. Inspect the actual files/processes/receipts before deciding a recovery. Scope changes and cancellation invalidate late evidence. Repeated unchanged verification failures have backoff and a resumable retry-budget blocker; repair the bound sources or environment before retrying.

Run `npm run test:ci:unit`, `npm run test:ci:integration`, `npm run test:ci:lisp`, and `npm run test:ci:coding:web`. The Web acceptance packs the plugin, installs it into a disposable native DSH profile and uses Chromium. Native generation is scripted: these tests verify tool transport, user choice, real effects and observed completion; they do not certify a particular live model's reasoning.
