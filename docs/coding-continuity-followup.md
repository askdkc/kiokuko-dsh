# Coding continuity follow-up to 9bcbbf41

This is the historical f9335f2 verification record. See [the subsequent package/shutdown/CI follow-up](package-shutdown-ci-followup.md) for the initialization ownership correction and current validation limits.

## Changes

- Custom LLM errors use one capability-based bridge. Modern SDKs use `fromFailure`; older SDKs retain their string-code constructor. Provider facts, cause and existing redaction remain intact.
- Auxiliary DB wrappers share a per-runtime limit of four unresolved operations. Caller timeout does not release capacity. Close cancels callbacks waiting for resource acquisition, rejects new work and drains callbacks already executing before closing the connection. An underlying initializer or already executing asynchronous DB operation must still settle before safe shutdown; this change does not forcibly interrupt SQLite or close a connection in use.
- Memory validation/rebuild/retry share a monotonic 1,500 ms deadline. Ordinary provider retries get a separate budget. Optional execution-memory DB failure retires owned memory and rebuilds without it; native identity and Stop checks remain required. Initial-input persistence checks the captured signal, agent/session objects and generation before effects and before adopting results.
- `memory_explain` records ownership in native tool-result metadata, including registration UUID, session generation, immutable header digest and call sequence/ID and the explained entry ID/revision. The canonical value retains existing explanation fields and adds `kiokukoExplanationProof`; the model rendering excludes that field. No receipt-table migration is needed. Both quarantine and forgotten-memory filtering require native provenance. Forgetting reads the native result's entry ID, not a possibly stale DB receipt sharing its session/call ID. Unproven legacy results and ambiguous duplicate call IDs are retained, not attributed by tool name.
- Adjacent old snapshots/markers coalesce using native contiguous replacement. Interleaved human/tool nodes prevent coalescing. Audit events remain intact. `runtimeContextMarkerCopies` and `runtimeContextMarkerBytes` measure retained markers separately from runtime snapshots using serialized UTF-8 messages.

## Verified source scope

On macOS arm64, Node 26.7.0, official DSH fixture f3803c96974ad4a94195fb97e5c637e9c2a3afe3:

- TypeScript check passed with the selected official fixture consistently staged in development and test dependencies.
- 344 selected unit/integration tests passed, zero skipped: auxiliary DB, deadline/Stop, explanation provenance, LLM errors, OpenCode codec/stream, efficiency, runtime-context, native harness, core/full memory evidence/review, runtime lifecycle, process-crash recovery, answer-context boundaries and on-demand review regressions.
- 1,000 held auxiliary attempts created at most four underlying operations; expired operations performed no delayed writes.
- 50/1,000/5,000 adjacent and interleaved snapshot cases preserved human inputs and audit events and were idempotent.
- Official JSONL persistence survived process exit after 17 retirement writes, then two fresh-runtime resumes. The existing process-crash test also verified no repeat of a previously started file effect.
- Isolated deliberate faults in capacity enforcement, session provenance, adjacent merging and the modern error bridge caused six selected assertions to fail. The working source passed those tests.
- Final source typecheck, build and all 344 selected tests passed after the receipt-collision correction. The collision regression failed before that correction and passed after it.
- The old 0.2.1-alpha.3 LLM module passed 58 error/codec/stream tests. The actual LlmError class extracted from e8f7b93 passed the same 58 tests in an isolated mixed SDK graph. An in-memory TypeScript declaration overlay using e8f7b93's exact built-in code list and fromFailure signature produced zero diagnostics. These are error-boundary checks, not full-version runtime compatibility.
- The modern `fromFailure` contract was inspected in official DSH e8f7b93 (`packages/llm/llm/src/index.ts`). The capability branch is unit-tested; a complete e8f7b93 build/runtime matrix is NOT established. The shell could not resolve github.com to obtain that checkout.

The repository's full CI verifier must be assessed separately from the selected tests. Native model responses in these tests are controlled fixtures, not real-provider validation. No commit or push is part of this change.

## Broad verification outcome

The ordinary `node scripts/verify.mjs --profile main` attempt was stopped after observed `/bin/ps` and socket `EPERM` failures and stalled Lisp tests. A second attempt used the existing `KIOKUKO_TEST_TIMEOUT_MS=60000` control and reached a terminal result for all 24 scheduled checks: **13 passed, 10 failed, 1 prerequisite-missing**. This is not a passing default CI run. It preceded the final receipt-entry collision correction; the affected native memory tests, typecheck and build were rerun on the final source as described above.

| Check | Result |
|---|---|
| verification-contract | failed |
| typecheck | passed |
| build | passed |
| native-unit | failed |
| native-integration | prerequisite-missing |
| native-e2e | failed |
| skill-efficiency | passed |
| coding-offline | passed |
| harness | passed |
| retrieval | passed |
| decision-evaluation | passed |
| intent-evaluation | passed |
| answer-evaluation | passed |
| memory-reuse-evaluation | passed |
| sampledb | passed |
| publint | passed |
| prepare-reproducibility | failed |
| dsh-cli-profile | failed |
| sqlite-vec | passed |
| pack-check | failed |
| skill-delivery | failed |
| consumer-npm | failed |
| consumer-pnpm | failed |
| dsh-cli-packed | failed |

Observed blockers: `/bin/ps` execution and Unix/TCP listen denied with `EPERM`; `registry.npmjs.org` DNS failure; protected-python3 unavailable; bounded suite and package-install timeouts. CLI startup failed specifically at Lisp process identity (`spawnSync /bin/ps EPERM`). No security/ownership checks were disabled to make these tests pass. The available environment cannot establish full CI success or full new-DSH compatibility.

Reproduction commands:

```sh
npm run typecheck
npm run build
node --import tsx --test tests/dsh/unit/auxiliary-database.test.ts tests/dsh/unit/memory-request-fence.test.ts tests/dsh/unit/explanation-provenance.test.ts tests/dsh/unit/explanation-receipt-collision.test.ts tests/dsh/unit/llm-error.test.ts tests/dsh/unit/harness-runtime-context.test.ts
node --import tsx --test tests/dsh/integration/session-recovery-native.test.ts tests/dsh/integration/runtime-lifecycle.test.ts
node scripts/verify.mjs --profile main
```

The complete 344-test source selection additionally includes native core/full memory evidence/review, harness, efficiency, OpenCode codec/stream, answer-context boundaries and on-demand regressions. Native runs used `KIOKUKO_DSH_PACKAGE_ROOT=$PWD/tests/fixtures/dsh-runtime/node_modules` and `KIOKUKO_REQUIRE_DSH_NATIVE=1` with the official fixture stated above.
