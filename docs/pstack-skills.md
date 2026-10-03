# Focused Kiokuko skills

Seven specialists add investigation, architecture, review, benchmarking, verification recipes, skill authoring and technical writing. SOUL selects them only for relevant tasks. Existing code/UI/Enno/memory contracts remain authoritative. See [the adaptation ledger](pstack-adaptation.json) for all 49 upstream skills and 23 playbooks, pinned to the recorded commit. Upstream code is not installed or executed.

The common guidance targets GPT-6 Astra and GPT-6.1 Sol without selecting either model or forcing a reasoning budget. Outcomes, constraints and evidence take precedence over ritual steps. Model quality remains **unmeasured** until both actual models are evaluated; local content and delivery tests do not establish model improvement.

## Evaluation

Run `node scripts/run-skill-quality.mjs --pstack --config <config.json> --output <new-directory>` separately for each model. Configuration uses the existing explicit model, revision, endpoint, credential environment-variable name and request/token/time budgets documented by the quality runner. Never put credentials in files. With no configuration the runner makes zero requests and reports unmeasured.

Each case runs three times in rotated baseline-full, candidate-full and compiled order. The baseline is the frozen pre-adaptation source. New specialist guidance is absent from that baseline. Record per-model results separately; do not pool away regressions. The runner records usage, loaded bytes, elapsed time and exact model identity. These are no-tool decision probes, not proof of coding quality or live application behavior. Review the rubrics blind for prose/design quality and run the existing skill-coding evaluator for actual code tasks. A configured endpoint must support the runner's chat-completions contract; do not substitute another model if it does not.

Source, compiled, native and packed verification remain separate. Installation into the user's active profile and publication are outside this change.
