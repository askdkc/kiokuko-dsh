# Coding and work records in DSH

An explicit request to implement or repair code starts a task-bound workflow. Questions, explanations, quotations, undecided alternatives and plan-only requests retain the conversation/read-only path. Classification is advisory and cannot authorize an unrequested change.

Clear unowned native implementation requests offer Lisp before the first model request. A session with Lisp already enabled selects its explicit Lisp route without another question. An explicit task answer takes precedence, and the answer is reused for the same request. The choice grants no native permission.

Before that offer, the host may use the configured request-intent decision as an advisory positive signal. A resolved change/implementation decision arms the same offer for conversational wording; abstention, unavailability, a non-positive decision or no decision service falls back to the deterministic detector. The decision never replaces the main model's request interpretation or grants permission.

Work starts from the user's request and the host's execution authority. The coding record is optional context. Lisp selection is independent of whether a Goal or checks have been registered. An explicit decline uses ordinary tools, a selected route requires its runtime, and cancellation stops dispatch while preserving results. `coding_workflow next` can reopen an explicit pending Lisp question. The native startup and protected Lisp boundaries retain their own authority checks.

## Lisp coding prototype

For a protected coding workflow with Lisp ON, run a small relevant `lisp_eval` with `prototype: true`, then read its successful saved `operationId` with `lisp_inspect` (`resultOperationId`, `section: "result"`, complete page from offset zero). Protected implementation waits for execution and inspection. Two failed attempts stop automatic retries. Recover the cause or explicitly disable Lisp. A fresh request cannot replay an old prototype operation. For ordinary coding, use a prototype when it helps verify the work.

## Model-facing API

`coding_workflow status` shows the original request, the latest annotation, and available observations from the native log and host receipts. While the task is active, call `coding_workflow_apply` with `{"action":"annotate","notes":"...","evidenceRefs":[]}` to add context. References are optional. The host assigns the annotation ID and separates unknown references from observed ones. A failed annotation update leaves already executed work intact.

Legacy `propose` and `revise` still accept `expectedRevision` and `definition`. Goal and item checks can share a criterion. Repeated identical references are normalized and incomplete Goal mappings stay open. Task scope changes stale earlier evidence. Execution continues under the current source-bound request and applicable tool permissions.

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

A shared criterion uses one current observation for both roles. A distinct final Goal check retains its requirement for an execution after the item checks. Related source paths, package/configuration/lockfiles, runtime identity, criterion revisions and scope determine freshness. Add generated/installed artifact paths to `sourcePaths` when they affect the behavior. No-op suites, zero explicit cases, skips, missing output, unsuccessful child processes, interruption and untrusted results remain unmet or unknown. A nonempty test case still needs meaningful assertions: the host cannot prove an arbitrary test's specification quality.

Ordinary task completion and coding verification are reported separately. A task can close with an incomplete record or unverified checks. Explicitly bound execution protocols still enforce their evidence requirements.

## Recovery and verification

Definitions, task answers, CAS revisions and replay receipts are durable. Exact retries return stored results; changed input under an existing call ID conflicts. Owned execution journals preserve operation identities and return unknown after a crash instead of repeating an uncertain effect. Inspect the actual files/processes/receipts before deciding a recovery. Scope changes and cancellation invalidate late evidence. Repeated unchanged verification failures have backoff and a resumable retry-budget blocker; repair the bound sources or environment before retrying.

Run `npm run test:ci:unit`, `npm run test:ci:integration`, `npm run test:ci:lisp`, and `npm run test:ci:coding:web`. The Web acceptance packs the plugin, installs it into a disposable native DSH profile and uses Chromium. Native generation is scripted: these tests verify tool transport, user choice, real effects and observed completion; they do not certify a particular live model's reasoning.
