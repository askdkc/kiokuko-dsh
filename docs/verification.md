# Repository verification

Goal: CI executes the same repository-owned verification contract as local development.
`npm run verify` runs the full applicable scope. `npm run verify -- --profile main`
and other profiles are explicitly partial. `npm test` remains a fast/focused entry.

Inspect `npm run verify:plan` before running. Each check declares its runner,
dependencies, required capability and required result in `scripts/verification.json`.
CI prepares environments, selects profiles and retains output. Missing required
capabilities are `prerequisite-missing`; unexpected skips, empty Node suites and
failed assertions are non-success. Platform exclusions are declared before execution
and recorded with a reason. Exclusions never imply a result on that platform.

Output defaults to a fresh OS temporary directory. Supply an empty directory
outside the repository with `--output`. `plan.json`, per-command logs, official
Node lifecycle reports, `progress.json`, `result.json` and the candidate archive
are retained. Reports identify source content, runtime, profile, contract and archive.

All package consumers run after a final clean build and pack, against the same
archive and hash. Installed smoke/host assertions remain the existing assertions.
The DSH core pack and Skill consumers use normal minimal installs, with no links
to the development node_modules. Changes during verification are `stale`; saved
results must be rechecked using `npm run verify -- --status <result.json>`.
A profile passing alone never sets `completionReady`. A stale or failed full run
must not be reported as full verification, and local results do not prove remote CI.

## Existing CI checks and common suites

The runner inventory below preserves the previous CI checks. The former DSH
`npm test` is covered by native unit/integration/e2e plus dedicated Skill delivery;
its standalone `.mjs`, Python, browser, package and evaluation checks remain explicit.

| Common check | CI profile(s) | Existing runner | Required result |
| --- | --- | --- | --- |
| verification-contract | main, semantic, lisp, browser, runtime | `node --test scripts/verification-contract.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| typecheck | main | `npm run typecheck` | exit 0 |
| build | main, semantic, lisp, browser, runtime | `npm run build` | exit 0 |
| native-unit | main | `node scripts/run-ci-native.mjs unit` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| native-integration | main | `node scripts/run-ci-native.mjs integration` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| native-e2e | main | `node scripts/run-ci-native.mjs e2e` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| skill-prompts | main | `npm run test:skill-prompts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| skill-efficiency | main | `npm run test:skill-efficiency` | existing independent assertions finish, emit their result and exit 0 |
| coding-offline | main | `node --test tests/fixtures/skill-coding/offline.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| index-reasoning | main | `npm run test:index-reasoning` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| index-evaluation | main | `npm run test:evaluation:index-reasoning` | existing independent assertions finish, emit their result and exit 0 |
| harness | main | `npm run test:harness` | existing independent assertions finish, emit their result and exit 0 |
| retrieval | main | `npm run test:evaluation` | existing independent assertions finish, emit their result and exit 0 |
| decision-evaluation | main | `npm run test:evaluation:decisions` | existing independent assertions finish, emit their result and exit 0 |
| intent-evaluation | main | `npm run test:evaluation:request-intent` | existing independent assertions finish, emit their result and exit 0 |
| answer-evaluation | main | `npm run test:evaluation:answer-review` | existing independent assertions finish, emit their result and exit 0 |
| memory-reuse-evaluation | main | `npm run test:evaluation:memory-reuse` | existing independent assertions finish, emit their result and exit 0 |
| sampledb | main | `npm run test:sampledb` | existing independent assertions finish, emit their result and exit 0 |
| publint | main | `npm run publint` | exit 0 |
| prepare-reproducibility | main | `npm run verify:prepare` | existing independent assertions finish, emit their result and exit 0 |
| native-search | lisp, runtime | `node scripts/run-tests.mjs tests/dsh/integration/native-search.test.ts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| laya-worker | lisp | `npm run test:laya-worker` | exit 0 |
| lisp-vendor | lisp | `npm run verify:lisp:vendor` | existing independent assertions finish, emit their result and exit 0 |
| lisp-native | lisp | `npm run test:ci:lisp` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| owned-native | lisp | `node scripts/run-tests.mjs tests/dsh/integration/owned-execution.test.ts tests/dsh/integration/owned-native-lifecycle.test.ts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| modules | lisp | `npm run test:modules` | existing independent assertions finish, emit their result and exit 0 |
| models-web | browser | `npm run test:models:web` | existing independent assertions finish, emit their result and exit 0 |
| coding-web | browser | `npm run test:ci:coding:web` | existing independent assertions finish, emit their result and exit 0 |
| shortcuts-web | browser | `npm run test:shortcuts:web` | existing independent assertions finish, emit their result and exit 0 |
| lisp-approval-web | browser | `npm run test:lisp:approval:web` | existing independent assertions finish, emit their result and exit 0 |
| lisp-plan-web | browser | `npm run test:lisp:plan:web` | existing independent assertions finish, emit their result and exit 0 |
| pack-check | main, lisp | `node scripts/pack-check.mjs` | existing independent assertions finish, emit their result and exit 0 |
| skill-delivery | main, lisp | `node scripts/run-skill-delivery.mjs` | existing independent assertions finish, emit their result and exit 0 |
| consumer-npm | main, runtime | `node scripts/verify-agenticreplay-consumer.mjs` | existing independent assertions finish, emit their result and exit 0 |
| consumer-pnpm | main, runtime | `node scripts/verify-agenticreplay-consumer.mjs --pnpm` | existing independent assertions finish, emit their result and exit 0 |
| dsh-lifecycle | main, runtime | `node scripts/run-enno-dsh-e2e.mjs` | existing independent assertions finish, emit their result and exit 0 |
| sqlite-vec | main, semantic | `npm run test:sqlite-vec` | existing independent assertions finish, emit their result and exit 0 |
| embedding | main, semantic | `node scripts/run-local-embedding-smoke.mjs --offline` | existing independent assertions finish, emit their result and exit 0 |

Linux, Windows, other architectures and real model quality require their own executions; Mac results do not cover them. Runtime setup is an environment prerequisite and is never installed silently by verify.
