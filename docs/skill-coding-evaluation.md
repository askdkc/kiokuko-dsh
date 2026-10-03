# Coding Skill evaluation

The three existing coding Skills bind required implementation methods, readable
responsibilities, independent test expectations and evidence-qualified completion.
This evaluator measures bounded fixtures, not general model ability or six-month
maintainability. No training-method or vendor-quality claim follows from its scores.

## Commands

- `npm run test:skill-coding:offline`: fixed good/bad fixtures, path ownership,
  budget, process bounds and a real DSH loop with a scripted adapter. No provider calls.
- `npm run build`, then `npm run test:skill-coding -- --config config.json --output new-results`:
  explicit live evaluation. Requires the pinned native DSH fixture dependencies,
  an already installed Docker engine and locally available digest-pinned Node image.
  It never pulls an image, installs Docker, chooses a model or loads a user profile.

Both `candidate` and `reviewer` in the JSON config require `provider`, `model`,
`revision`, `api` (a protocol supported by the installed DSH pi-ai adapter),
`baseURL`, `apiKeyEnv`, `contextWindow`, and `maxOutputTokens`.
Top-level fields are `allowRemote`, `image` (`name@sha256:<64 hex digits>`),
`maxRequests`, `maxTokens`, `maxDurationMs`, and `maxToolCalls`. All budgets are
positive explicit limits. Token admission conservatively reserves the entire
configured context plus output allowance per call; usage is recorded separately.
Revision is operator-supplied metadata, not proof of the provider's internal weights.

The output directory must have no report.json. Credentials are read only by the
host provider adapter and are not sent to generated programs. The host does not
mount personal configuration or memory plugins. Reviewer sessions have no tools.

## Evidence

Each of five fixtures runs three repeats in three counterbalanced conditions:
baseline full, current full, current compiled. Baseline resources are frozen in
`tests/fixtures/skill-coding/baseline.json`; the compression baseline is independent.
Initial and follow-up artifacts, diffs, hashes, observed checks and structured
claims are retained. Follow-up requests are withheld during the first turn.
Only source text and public reports are saved, not private reasoning streams.

Generated code executes only inside a read-only, non-root, network-disabled,
resource-bounded container. Each verifier consumes a frozen copy; writable agent
files cannot overwrite the authoritative oracle. A subprocess separates candidate
execution from assertions: exiting early without values is not a pass. The
container is removed after success, failure or timeout. Docker policy construction
is tested offline; that is not proof of runtime isolation on a particular machine.

Hard failures and blind review findings are separate. No number of favorable
review findings overrides a failed behavior, changed protected test or false
verification claim. Reviews must cite exact source quotes; they are still model
judgments. Unknown/skipped/runtime-blocked checks are never successes. The current
geometry fixture evaluates mesh data and translation, not a rendered scene.
The review fixture dynamically checks entry-point behavior; semantic dead-code,
empty-branch and architectural findings additionally depend on the blind reviewer.

No live configuration means no quality measurement. Source/packed/native Skill
delivery tests remain separate, as does deployment to a running client. Reports
never automatically change the default Skill mode. Compare all paired records;
failures, incomplete runs and reviewer findings must remain visible. Do not infer
statistical significance from three repeats.
