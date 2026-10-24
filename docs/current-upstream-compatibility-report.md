# Current upstream compatibility verification

Verified in the authorized cloud workspace on 2026-10-24. No commit, push, user Mac change, or official DSH source change was made.

## Source and artifact identity

- Plugin base: `askdkc/kiokuko-dsh`, `8c69b4afe69d7baf1ad6d0178a5c4c0388a0fb29`, plus the accompanying uncommitted changes.
- Official upstream: `https://github.com/deepseek-ai/deepseek-harness.git`, master resolved to `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (0.2.1-rc.3). The official working tree remained clean. This is evidence, not a newly hardcoded compatibility target.
- Node: v24.19.0. The CI matrix was not executed remotely.
- Built package: `kiokuko-dsh-0.2.22.tgz`, SHA-256 `0ec0660e89e4064a580218dad3136c9c931dfa8683ff8a355b748989c7918743`.
- Core source SHA-256: `src/dsh/lisp/surface.ts` = `039ce216063b7441373419b30b9718d6b57ccf639d2f8ec1369e2dabbb968ab4`; `src/dsh/lisp/host-tool-dispatch.ts` = `afab866f7da91e535f23dab628bc228a266e2c7ffa579e43c69f6cf9a29f08ae`; `src/dsh/models/surface.ts` = `748bc51240434735209dbcab81a5d2c222b3f3d942b9ad14a2b9694c9271e39b`.
- The three corresponding current dist modules were byte-identical to the extracted tested package at final verification. The subsequent pinning re-audit also corrected the shipped repair catalog resolver; the final repack status is recorded below. The earlier archive remains separate evidence, not proof for the later package.

## Changes and boundaries

Current DSH owns executor selection. Lisp preserves native/PTC selection and the executor-owned request schema rather than calling removed `presentAs` or installing an irreversible executor override. Host-owned nested calls use the exported official execution pipeline, preserving parent/root identity, guards, cancellation and task authority. Current model selection uses `agent.model.select`; legacy behavior remains capability-selected.

Protected native execution retains the scoped restrictions and persistent guard, including unload/reload boundaries. Protected PTC `run_code` is explicitly rejected before interpreter dispatch, with an actionable native-executor requirement. This is not support for running protected Lisp programs through PTC. Tests use a sentinel PTC interpreter to prove transport preservation and zero execution on denial, not a real PTC process interpreter.

CI now resolves official master once, records its exact SHA, builds that source, and stages the same official graph in both fixture and root module resolution. Mismatched identities and stale fallback packages fail. The historical fixture manifest/lock and release evidence remain reproducibility data, not a fixed compatibility gate. Schema tests use actual schema/constructor exports rather than release prefixes.

## Executed checks

The reported original missing `presentAs` failure was reproduced before repair. Reverting current nested dispatch to the old single-call entry failed against actual batch execution; removing protected guards failed the denial/unload regressions. These were disposable test mutations and were restored.

Commands were run from the plugin checkout, with `TMPDIR` outside the checkout for production regressions. `KIOKUKO_DSH_PACKAGE_ROOT` pointed to `tests/fixtures/dsh-runtime/node_modules`, staged from the verified official checkout. `KIOKUKO_EXPECTED_DSH_SHA` was the resolved SHA above.

- `npm run typecheck`: passed against current official declarations, including final harness edits.
- `npm run build` and `npm pack --ignore-scripts`: passed. The official monolithic build had exceeded cloud memory; required official bundles/declarations were subsequently built selectively without source changes.
- `KIOKUKO_LISP_BUILT_ROOT=<extracted package>/dist node --import tsx --test tests/dsh/integration/lisp/current-executor.test.ts`: 8 passed, 0 failed, 0 skipped. Actual official native/PTC executors, nested pipeline policies/cancellation, protected boundaries, task authority, and actual new-session AgentLoop turns in development and protected modes.
- `node scripts/run-tests.mjs tests/dsh/unit/lisp tests/dsh/unit/native-execution-ownership.test.ts`: 267 passed, 0 failed, 0 skipped.
- `node --import tsx --test tests/dsh/unit/kiokuko-models-service.test.ts`: 25 passed, 0 failed, 0 skipped.
- `node --test scripts/verification-contract.test.mjs`: 64 passed (including seven optional current-source graph/configuration tests). Native CI runner tests: 8 passed. Staging tests: 2 passed, including stale-package removal and origin/revision identity checks. Deliberately stale source-selection/staging variants failed as expected.
- Ten Lisp integration files (`native-surface`, `hot-native-surface`, `guardrail-native-policy`, `p0-native-guard`, `attachment-surface`, `plan-surface`, `read-surface`, `owned-development`, `conversation-intake`, `code-intelligence-native`) with task-local SBCL: 24 tests, 19 passed, 3 failed, 2 skipped. The three protected-runtime failures all report `bwrap: NETLINK_ROUTE ... Operation not permitted`, including the hot compile failure payload. No sandbox restriction was weakened or test skipped to hide these failures. Conversation intake passed all five modes with actual native Bash approval/process dispatch. Two code-provider variants skipped because the separately built optional V1 provider fixture was absent.
- Both packed plugins were installed into a real official CLI host. Authenticated HTTP create/bind/commit, actual `enable-task`, an actual model-emitted `lisp_status` tool call with `isError:false` and `TASK_READY`, completion of that same model turn, and identity/history after restart passed. The LLM was scripted, not a paid external provider. Browser clicking was not validated: the cloud browser process was blocked by environment IPC restrictions.
- Harness evidence identity was checked against the actual staged graph: current installed version/SHA reported, deliberately wrong expected SHA rejected. This check does not claim execution of all harness scenarios.
- `git diff --check`: passed. Final source/artifact hashes were rechecked.

The main CI intentionally excludes the optional code-provider suite. The separate `code-intelligence.yml` workflow now resolves current official master using the same resolver, builds its exact SHA and stages the provider graph after dependency installation. Source tests, packed-profile installation, both packed consumers, and benchmark validate that selected source graph. Current packed installation does not reconstruct unpublished source from registry version labels or inject the historical vendor CLI. The independently reviewed provider protocol baseline is preserved. Seven synthetic/configuration regressions passed, including mismatched and same-version stale graph rejection. Actual optional-provider runtime acceptance remains unverified because its independently built fixture was not installed in this cloud run.

## Evidence and remaining gaps

Task-local logs and hash manifests are in `.artifacts/current-upstream-fix/` and `.artifacts/current-upstream-ci/`; the report above preserves meaningful results independently of those ignored temporary files. The sibling combined HTTP evidence is under `dsh-chat-current-fix-20261024/.test-tmp/dsh-regular-chat-integration-8fWVwM/http-chat-evidence.json` in the same cloud task.

Full GitHub/multiplatform CI, the optional built V1 provider integration, protected SBCL execution in an environment permitting its required bubblewrap isolation, and browser interaction remain unverified. History-format/semantic-compaction test changes were typechecked and source-reviewed, not claimed as full native-suite passes. No user installation or live deployment was changed. The workspace's optional evidence-guard executable was absent; no automated guard pass is claimed.

## Final pinning re-audit and local CI reproduction

The later full pinning audit found default command paths that still accepted the historical locked fixture when no expected SHA was supplied. These defaults now require a coherent staged official-source identity. Historical reproducibility is a separate explicit `KIOKUKO_DSH_RUNTIME_MODE=historical` mode and cannot masquerade as a current-SHA run. Shared preflight covers native CI, optional provider, standalone harness, lifecycle and browser commands. Multilingual installation instructions no longer describe old alpha release names as current compatibility requirements. Release evidence, language-engine minimums, schema/protocol versions and historical locks remain intact.

For a local current-runtime verification subset on an authorized local machine, use a separate **clean official checkout**, not an edited host checkout. These commands are instructions, not evidence that local execution occurred. Resolve master once and retain the returned SHA for the whole run:

```sh
npm ci
npm ci --prefix tests/fixtures/dsh-runtime
export KIOKUKO_EXPECTED_DSH_SHA=$(node scripts/resolve-dsh-upstream.mjs)
# In a separate official checkout, check out that exact SHA, then run:
# pnpm install --frozen-lockfile
# pnpm run build:artifacts
node scripts/stage-dsh-upstream.mjs /absolute/path/to/clean-official-dsh tests/fixtures/dsh-runtime "$KIOKUKO_EXPECTED_DSH_SHA" .
node --test scripts/verification-contract.test.mjs
node --test scripts/stage-dsh-upstream.test.mjs
npm run typecheck
npm run build
npm run test:ci:unit
npm run test:ci:integration
npm run test:ci:lisp
npm run test:ci:e2e
npm run test:ci:metadata
git diff --check
```

Do not set the historical runtime mode for a current compatibility run. Native Lisp requires SBCL and the operating system's supported isolation facilities; the cloud's bubblewrap failures cannot predict a local macOS result. Browser lanes additionally require the supported Playwright browser installation and a working browser process: `npm run test:ci:approval:web`, `npm run test:ci:coding:web`, and `npm run test:ci:shortcuts:web`. They are heavier than the narrow regressions above. These local commands are not the complete hosted CI selection, lane partition, microjudge targets, artifact aggregation or platform matrix; hosted CI cannot be claimed without executing its workflow.

Optional code-provider acceptance additionally prepares a separate reviewed provider checkout and dependencies. After staging current official DSH, use `node scripts/prepare-code-provider.mjs`, `npm run test:code-intelligence`, `npm run test:code-intelligence:packed`, and `npm run test:code-intelligence:benchmark`. These are optional heavy checks, not substitutes for ordinary plugin acceptance. No local or remote CI success is asserted until those commands actually complete.

### Re-audit execution status

The production repair resolver now treats an explicitly supplied missing or broken package root as an error and never silently falls back to the installed package or historical test fixture. With no override it resolves the installed production catalog, without requiring Git staging metadata. New catalog-selection regressions passed 3/3; the pre-fix resolver failed the explicit-root and implicit-fixture counterexamples (with only a test export added). The actual current catalog repair integration passed 8/8. The typesafe-command release-label branch was replaced by the actual credential writability contract.

Final independent re-audit found no remaining arbitrary DSH release predicate in the inspected current source/scripts/tests, and no remaining identified silent historical fallback in current-runtime entrypoints. This excludes intentionally retained historical locks, protocol/schema identities and synthetic evaluations. Independent selection/staging checks passed 12/12 with no skips; this is not proof of full native or hosted CI success.

The final repair-script change is **not covered by the earlier packed HTTP artifact**. A new build reached final output generation, but final repack was blocked by the environment's authorization review; the one evidence-based retry also produced no archive (its recorded npm failure was an unavailable default cache directory). No further packaging workaround was attempted. Therefore final source transfer may proceed independently, but latest-archive packed/HTTP acceptance remains pending. The earlier archive/hash and combined HTTP result above apply only to their earlier source state.

The last re-audit checks separately confirmed default-selection regressions 10/10, native planner 9/9 and actual-current typesafe command 1/1. The later full-contract run stopped without a terminal summary; its chained typecheck did not start. Earlier 64/64 and typecheck success above must not be relabeled as verification of these final re-audit edits. The catalog regression was subsequently included in the contract aggregator; that final aggregation has not run.
