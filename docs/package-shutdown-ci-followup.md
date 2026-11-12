# Follow-up to f9335f2: package loading, shutdown and CI fixtures

## Implementation

- `runtime-context-marker.ts` owns the constant and predicate without any imports. Efficiency no longer imports the harness, and the harness re-exports the helpers for existing callers. Public root, DSH, core and Lisp-module exports load without optional DSH peers.
- Runtime shutdown cancels admission and initialization through a shared signal. Unpublished initialization resources remain owned by the initialization task. `close()` does not wait on that task; every awaited acquisition is fenced before use/publication, and a late DB connection is closed by its acquiring task. Backend settings probes also respect cancellation. The default migration initializer checks cancellation at asynchronous boundaries and before commit, preserving its rollback/cleanup logic.
- Already executing DB callbacks and queued writes still drain before the published shared connection closes. This is intentionally not a timeout that closes a connection underneath its users. A custom initializer that ignores cancellation remains responsible for its private resources until it settles; cancellation cannot forcibly terminate arbitrary third-party I/O or guarantee process exit when that I/O retains an OS handle.
- Initial-input capture forwards `source?.signal` to auxiliary DB acquisition, so Stop does not wait for the optional 250 ms deadline. Existing identity/generation checks remain in place.
- PTC integration fixtures emit parsed results with `inspect(JSON.stringify(...))`, including the assessment calculation. A bare program return is not conversation output under the current executor contract. Production execution policy is unchanged.
- Question fixtures obtain the actual bundled carrier via the plugin's public `userQuestionPanels.review` registration instead of rewriting bundle text. The constructor receives a call ID, not an AbortSignal. Behavioral tests cover hide, cancel, empty answers and composer selection on both the original and esbuild-minified bundle. Renderer/store services are fixture adapters; the carrier is the actual upstream implementation. These are not macOS UI end-to-end tests.

## Verification environment and evidence

macOS arm64, Node 26.7.0. Installed official DSH source is **f3803c96974ad4a94195fb97e5c637e9c2a3afe3**, version 0.2.2-alpha.2. This is not a full e8f7b93 compatibility run.

Typecheck, build and publint passed. The final main regression selection returned 71 successes and 14 environment failures (85 total, zero skipped); the six separately selected native request-plan cases and all 20 question tests passed. The question tests are included in the 71 successes, not additional to them. The separately rerun eight scripted coding-input failure/repair cases also passed.

Before the fixes:

- The packed package failed with `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-llm` through `dist/dsh/harness/runtime-context.js`.
- With initialization held, close had not completed after 80 ms, including 1,000 auxiliary attempts. Releasing initialization allowed cleanup.
- Stop during held initial-input DB acquisition had not returned after 80 ms and waited for the optional deadline.

After the fixes, tests cover:

- Packed public imports with only required dependencies/required peers, and marker counts/UTF-8 bytes. The test reuses installed required dependencies; it is not a fresh registry installation.
- Close before initialization settles; cancellation of waiting start, agent creation and queued writes; zero late callbacks and zero late publication.
- Late DB open with both explicit embedding configuration and settings-probe configuration: no use, exactly one close.
- Late initialization rejection without an unhandled rejection or reopening.
- Default initializer cancellation before path reservation, after writable open and before commit; no committed migration tables, and a subsequent exclusive transaction succeeds.
- Existing transaction drain, native process-crash recovery, runtime-context retirement and scripted write/fail/repair/pass paths.
- Stop completes within the 80 ms observation window and performs no late write.
- Question behavior is independent of minification. A disposable check applying the previous exact-text rewrite to the minified real bundle returned no `PendingQuestion`, confirming sensitivity to the reported regression.

Commands for the focused regression suite:

```sh
npm run typecheck
npm run build
node --import tsx --test \
  tests/dsh/integration/runtime-lifecycle.test.ts \
  tests/dsh/unit/auxiliary-database.test.ts \
  tests/dsh/unit/efficiency.test.ts \
  tests/dsh/unit/harness-runtime-context.test.ts \
  tests/dsh/integration/auxiliary-recovery.test.ts \
  tests/dsh/integration/session-recovery-native.test.ts \
  tests/dsh/e2e/coding-workflow-native.test.ts \
  tests/dsh/integration/coding-input-retry-native.test.ts \
  tests/dsh/integration/optional-dsh-consumer.test.ts \
  tests/dsh/unit/question-api-compatibility.test.ts \
  tests/dsh/unit/lisp/coding-question.test.ts \
  tests/dsh/unit/recording-question-shortcuts.test.ts
node --import tsx --test --test-name-pattern=', native,' \
  tests/dsh/integration/request-plan-native.test.ts
npm run publint
```

## Limits and failed checks

- The earlier 72-test selection finished with 58 successes and 14 failures. All 14 failures in `e2e/coding-workflow-native.test.ts` reported `spawnSync /bin/ps EPERM` from LispManager startup. They are not counted as passing.
- The PTC request-plan cases fail before execution with `sandbox-exec: sandbox_apply: Operation not permitted`, both before and after the fixture change. The two pending-memory cases reach the same sandbox failure when run with the explicit installed package root and expected version. No sandbox bypass was used. The eight PTC cases require rerunning in a permitted native CI environment.
- Native request-plan assessment cases pass locally before and after these edits. This does not explain or disprove the user's four assessment failures on e8f7b93; those remain unverified against that revision.
- `scripts/verify-agenticreplay-consumer.mjs` cannot install the clean consumer because `registry.npmjs.org` returns `ENOTFOUND`. The existing npm/pnpm consumer suite is not established as passing.
- Hosted run 43131871349 is the baseline f9335f2 run, not this working-tree change. The API reports 14 successful jobs, six failing verification jobs and the additional failed aggregate gate. Its integration logs show the PTC failures; native assessment cases passed there. Its consumer log confirms the optional-module loading defect.
- No complete CI pass, real-provider test, or interactive macOS/Lisp validation is claimed. No commit or push was performed.

## d63a3a0: remaining PTC output fixture correction

Verified [run 43136607436](https://github.com/askdkc/kiokuko-dsh/actions/runs/43136607436): 19 jobs passed; main integration and the aggregate gate failed. Integration job 130913823299 failed only the core/full pending-memory cases at the expected `MUST_NOT_RUN` output assertion. All four request-plan assessment variants passed in that hosted run.

Changed the two output-asserted fixture programs from `return "MUST_NOT_RUN"` / `return "PTC_MEMORY_REVIEW_COMPLETE"` to `inspect(...)`. Production code and assertions are unchanged. The preparation carrier and review submission do not assert returned text and retain their existing program forms.

Local `npm run typecheck` and `git diff --check` passed. Re-executed the two native cases with `KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" KIOKUKO_EXPECTED_DSH_VERSION=0.2.2-alpha.2 KIOKUKO_REQUIRE_DSH_NATIVE=1 node --import tsx --test tests/dsh/integration/ptc-pending-memory-native.test.ts`. Both fail earlier at status execution because macOS denies `sandbox-exec` (`sandbox_apply: Operation not permitted`). The installed official DSH remains f3803c9; no local e8f7b93 pass or new hosted CI pass is claimed. The user's independent two-case pass on e8f7b93 is reported evidence, not a test executed here.
