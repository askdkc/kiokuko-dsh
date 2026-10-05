# Evidence-backed Lisp coding plans

The canonical `kiokuko-lisp` Skill contains the mandatory runtime block
`prototype-driven-planning`. It applies to admitted Lisp coding, planning and
review. It asks the model to settle testable doubts with current evidence or
small authorized target-runtime probes, choose controls/counterexamples before
execution, retain observations and failures, and use that evidence in one plan.
Existing permissions, read-only inputs, scratch, host approvals, generation and
result ownership, recovery and verification contracts remain authoritative.
Non-coding tasks do not acquire a coding-experiment requirement. There is no new
host execution gate, schema, tool or fixed experiment-count limit.

The full representation remains the default. Runtime compilation preserves the
new block and the previous contract. The unchanged fixed size baseline still
requires aggregate reduction of at least 30% and no representative request growth.
The added Lisp runtime is 320 UTF-8 bytes (318 bytes of text plus separators).
The one-shot Skill folds the conditional reference into its existing Lisp paragraph
with a net increase of 24 bytes, staying within its separate 6 KiB limit. Neither is a
provider token count or a price estimate.

## Local evaluation

Run from the source checkout with its development dependencies, Node >=24.16.0,
the pinned `tests/fixtures/dsh-runtime` dependencies, and protected SBCL. Linux
also needs Bubblewrap. `KIOKUKO_DSH_PACKAGE_ROOT` can select another installed
fixture root. The evaluation never installs runtimes or disables protection.
On macOS the calling environment must permit `sandbox-exec` to apply the worker's
sandbox; nested-sandbox denial is a failed prerequisite, not a passing skip.

```sh
# No provider call, no output file: reports unmeasured.
npm run test:lisp:prototype-planning

# Real DSH + protected Lisp, scripted model responses, no network.
npm run test:lisp:prototype-planning -- --offline --output /tmp/lisp-planning-results
```

Use a new output directory. An existing `report.json` is never overwritten at
startup. Each task gets a disposable workspace, state directory and isolated
Skill home; cleanup runs on success, failure and cancellation. The user's active
DSH installation/profile is not reloaded. The CLI discards inherited
`NODE_TEST_CONTEXT` before loading the standalone fixture.

The shared native fixture runs the production host adapter and composition with
an explicit immutable `DshSkillPrompts` source/artifact snapshot. Skill-delivery
tests use the same fixture through the normal source/packed plugin entrypoint.
This evaluates real tools and model-loop handoffs, not a substitute tool engine.
The evaluator itself is source-only and is not a consumer-package runtime API.

## Fixed comparison

`tests/fixtures/lisp-prototype-planning/before.json` preserves the pre-change
Lisp and one-shot source, original commit and SHA-256 digests. It is separate
from the historical compiler size baseline, which is unchanged. Other Skills,
inputs and environment are shared across these conditions:

1. before-full;
2. after-full;
3. after-compiled, with fallback rejected.

Eight cases run once in all three conditions (24 tasks). The starting condition
rotates between cases. Each task may make multiple model requests; task count is
not a request budget. The cases cover target-language boundaries, discriminating
alternatives, repeated measurements with equal results, fresh-evidence reuse,
contrary observations, plan-only preservation, unavailable runtimes and necessary
compatibility questions. B04 seeds evidence with a real host execution in the
same session and keeps that seed separate from model-initiated work.

`report.json` records source/input identities, runtime/platform, actual tool
arguments/results and refs, final plans, workspace digests, durations and
machine checks. A matching generated `passed` field cannot satisfy the checks.
The complete disposable workspace is hashed before and after the model turn;
proposals, staging or application fail the plan-only check. Failures are retained.
References must name actual results in that task. Exported evidence remains in
the report; the disposable live session/result store is removed on cleanup.

Offline success proves only the fixture, protection, tools and evidence pipeline.
Its model quality is always `unmeasured`, and it reports zero provider requests.
The scripted final text is a connectivity control, not a quality exemplar.

## Explicit live evaluation

The opt-in config uses the same connection validation and conservative reservation
budget as `test:skill-quality`. It requires a fixed model/revision, a compatible
streaming chat-completions endpoint, a credential environment-variable name,
remote permission and limits. No default provider or credential is selected.

```json
{
  "model": "your-fixed-model-id",
  "revision": "your-deployment-revision",
  "baseURL": "http://127.0.0.1:8000/v1",
  "apiKeyEnv": "LISP_EVALUATION_KEY",
  "allowRemote": false,
  "maxRequests": 120,
  "maxTokens": 8847360,
  "maxDurationMs": 600000,
  "contextWindow": 65536,
  "maxOutputTokens": 4096,
  "temperature": 0
}
```

```sh
npm run test:lisp:prototype-planning -- --config evaluation.json --output /tmp/lisp-planning-live
```

The existing native DeepSeek/OpenAI-compatible serializer performs tool-capable
model calls. Thinking is disabled for these fixed visible-plan probes. The
endpoint must return the configured model identity in its SSE response. The
revision is operator-supplied metadata; it is not independently attested by the
provider. Redirects, provider substitution and automatic retries are forbidden.
Every HTTP attempt reserves `contextWindow + maxOutputTokens`; failed attempts
keep that reservation. Actual usage is retained only when reported by the
provider. The response is capped at 4 MiB, each case at 90 seconds, and the suite
at its configured duration. Budget exhaustion and incomplete runs cannot pass.

A complete live run with passing machine checks reports `needs_review` and emits
`review.json`. Review final decisions against actual probe code/results: causal
use of observations, failed/counterexample results, justified alternatives,
freshness, limitations and whether a question is technically avoidable. B08
should ask the indispensable compatibility question. Machine-checked stdout
matching a known result does not prove that the model derived it honestly.
This runner never declares semantic quality automatically or promotes compiled
mode. No real-model behavior or billed-token improvement has been measured by
the offline suite.

## Delivery and regression checks

Run suites that rebuild/read `dist/` sequentially:

```sh
npm run typecheck
npm run test:skill-prompts
npm run test:lisp
npm test
npm run build
node scripts/run-skill-delivery.mjs
npm run test:skill-efficiency
npm run build:modules
npm run test:modules
npm run pack:check
```

Dedicated delivery uses real protected Lisp and verifies full/compiled,
persistent/task, first/follow-up/reload and source/extracted-package requests.
Module-package smoke checks verify the post-enable model body for core+Lisp;
core alone remains free of optional Lisp resources. Missing mandatory
prerequisites are failures. General-suite opt-in skips are reported separately.

Rollback removes only this runtime block, conditional reference and associated
changes, then rebuilds and reloads normally. Switching to full does not remove
the new rule because it is present in both representations. No DB migration or
worker reset is part of this change.
