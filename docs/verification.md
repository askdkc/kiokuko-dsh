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

## Common suites and retained assertions

The inventory below is generated from the repository contract. A script check
requires a fresh check-bound completion receipt after its existing assertions;
arbitrary stdout or a successful no-op process is insufficient.

| Common check | Profiles | Runner | Required result |
| --- | --- | --- | --- |
| verification-contract | main, semantic, lisp, browser, runtime | `node --test scripts/verification-contract.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| typecheck | main | `npm run typecheck` | exit 0 |
| build | main, semantic, lisp, browser, runtime, code-provider, p0, packages-live | `npm run build` | exit 0 |
| native-unit | main | `node scripts/run-ci-native.mjs unit` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| native-integration | main | `node scripts/run-ci-native.mjs integration` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| native-e2e | main | `node scripts/run-ci-native.mjs e2e` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| skill-efficiency | main | `npm run test:skill-efficiency` | explicit completion receipt |
| coding-offline | main | `node --test tests/fixtures/skill-coding/offline.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| harness | main | `npm run test:harness` | explicit completion receipt |
| retrieval | main | `npm run test:evaluation` | explicit completion receipt |
| decision-evaluation | main | `npm run test:evaluation:decisions` | explicit completion receipt |
| intent-evaluation | main | `npm run test:evaluation:request-intent` | explicit completion receipt |
| answer-evaluation | main | `npm run test:evaluation:answer-review` | explicit completion receipt |
| memory-reuse-evaluation | main | `npm run test:evaluation:memory-reuse -- --mode=all` | explicit completion receipt |
| sampledb | main | `npm run test:sampledb` | explicit completion receipt |
| publint | main | `npm run publint` | exit 0 |
| prepare-reproducibility | main | `npm run verify:prepare` | explicit completion receipt |
| native-search | lisp, runtime | `node scripts/run-tests.mjs tests/dsh/integration/native-search.test.ts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| laya-worker | lisp | `npm run test:laya-worker` | exit 0 |
| lisp-vendor | lisp | `npm run verify:lisp:vendor` | explicit completion receipt |
| lisp-native | lisp | `npm run test:ci:lisp` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| owned-native | lisp | `node scripts/run-tests.mjs tests/dsh/integration/owned-execution.test.ts tests/dsh/integration/owned-native-lifecycle.test.ts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| modules | lisp | `npm run test:modules` | explicit completion receipt |
| models-web | browser | `node scripts/verify-models-web.mjs` | explicit completion receipt |
| coding-web | browser | `node scripts/verify-coding-workflow-web.mjs` | explicit completion receipt |
| shortcuts-web | browser | `node scripts/verify-shortcuts-web.mjs` | explicit completion receipt |
| lisp-approval-web | browser | `node scripts/verify-lisp-approval-web.mjs` | explicit completion receipt |
| lisp-plan-web | browser | `node scripts/verify-lisp-plan-web.mjs` | explicit completion receipt |
| pack-check | main, lisp | `node scripts/pack-check.mjs` | explicit completion receipt |
| skill-delivery | main, lisp | `node scripts/run-skill-delivery.mjs` | explicit completion receipt |
| consumer-npm | main, runtime | `node scripts/verify-agenticreplay-consumer.mjs` | explicit completion receipt |
| consumer-pnpm | main, runtime | `node scripts/verify-agenticreplay-consumer.mjs --pnpm` | explicit completion receipt |
| dsh-lifecycle | main, runtime | `node scripts/run-enno-dsh-e2e.mjs` | explicit completion receipt |
| sqlite-vec | main, semantic | `npm run test:sqlite-vec` | explicit completion receipt |
| code-provider | code-provider | `node scripts/run-ci-native.mjs code-provider` | Explicit selected native fixture; nonempty official lifecycle without skipped required cases. |
| p0 | p0 | `node scripts/run-ci-native.mjs p0` | Explicit selected native fixture; nonempty official lifecycle without skipped required cases. |
| packages-live | packages-live | `node scripts/run-ci-native.mjs packages-live` | Explicit selected native fixture; nonempty official lifecycle without skipped required cases. |

## Consolidated duplicate invocations

- `skill-prompts` is covered by `native-unit`: `tests/dsh/unit/skill-compiler.test.ts`, `tests/dsh/unit/skill-snapshot.test.ts`.
- `index-reasoning` is covered by `native-integration`: `tests/dsh/integration/index-reasoning.test.ts`, `tests/dsh/integration/index-reasoning-native.test.ts`, `tests/dsh/integration/index-reasoning-evaluation.test.ts`.
- `index-evaluation` is covered by `native-integration`: `tests/dsh/integration/index-reasoning-evaluation.test.ts`.

Import-only convenience entrypoints remain usable explicitly. Recursive discovery
excludes these aliases and executes each declared leaf exactly once:

- `tests/dsh/integration/capability.test.ts`: `tests/dsh/integration/akinator-gate.test.ts`, `tests/dsh/integration/pre-step/gate.test.ts`, `tests/dsh/unit/capability-catalog.test.ts`.
- `tests/dsh/integration/close-resume.test.ts`: `tests/dsh/integration/run-close.test.ts`, `tests/dsh/integration/run-resume.test.ts`, `tests/dsh/integration/run-resume/exact-route.test.ts`.
- `tests/dsh/integration/enno-turn-stopping.test.ts`: `tests/dsh/integration/turn-stopping-gate.test.ts`, `tests/dsh/integration/enno-role-loop.test.ts`.
- `tests/dsh/integration/provider.test.ts`: `tests/dsh/integration/skill-provider.test.ts`.

## Explicit optional lanes

These files are excluded before ordinary discovery and recorded as scope-excluded
in the full plan. Selecting the named profile makes its fixture and assertions required.

- `code-provider`: `tests/dsh/integration/lisp/code-intelligence-native.test.ts`. This optional V1 provider requires an explicit built provider fixture.
- `p0`: `tests/dsh/integration/lisp/p0-seatbelt.test.ts`. This experimental macOS P0 candidate is an explicit probe, not production protection evidence.
- `packages-live`: `tests/dsh/integration/lisp/packages-live.test.ts`. Live public package registries are an explicitly selected integration lane.

## Removed no-op checks

- `embedding`: The old --offline invocation read no model manifest; DSH ships no preset manifest. Explicit --model-dir checksum/inference remains available.

The five browser consumers receive the same final tarball as CLI, npm and pnpm
consumers. Their standalone npm commands remain available; formal verification
executes the existing assertion scripts directly after its own clean build.

The old CI YAML substring test is retired: the common runner probes required
runtime capabilities and rejects missing prerequisites in the real execution path.
The fixture-version, suite-discovery and alias/optional-lane contracts remain tested.

`pre-step.test.ts` is also an import-only alias for `pre-step/gate.test.ts`.
Native Lisp integration requires `protected-python3`: a real sandbox subprocess
probe. An Apple launcher that only reports its version outside the sandbox does
not satisfy this capability. Local/CI environment preparation must select a real
installed Python interpreter; the repository never changes the global PATH.
