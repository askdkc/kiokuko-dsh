# Lisp recovery verification — 2026-10-21

Base: `f59448c2e492e3dd8f9c00b16e76172cfb1d7e09` (v0.2.18), with uncommitted Lisp changes. The exact current source SHA-256 values, per-trial outcomes, commands and temporary artifact manifest are preserved in [the machine-readable record](lisp-recovery-evaluation.json). Environment: macOS ARM64, Node v26.5.0, SBCL 2.6.8. Authentication-task changes in the shared checkout were preserved and are outside this change.

## Implemented and verified

The pure SBCL prototype compared `handler-case` (restart gone after unwinding) with `handler-bind` (lexical 41 retained, result 42); each incremented its preceding effect counter once. The implementation exposes explicit zero-argument restart choices on that live stack. It does not globally catch errors, replay an expression or restore a heap. `lisp_describe` and [API documentation](lisp-recovery.md) expose the entry.

Generation/evaluation/opaque-choice identities, synchronous one-time claim, task authority before/after provider work, host UNKNOWN/pending-effect checks, four consumed attempts, and selection/evaluation deadlines fence the continuation. Tests release late answers only after a new worker is live; a positive control can reach a host file-write adapter, while the old answer creates no marker and makes zero host effect calls. UNKNOWN records arising before or during selection and task revocation both prevent a restart.

Safety budgets are resource policy: 1–8 continuations (+ abstention), at most 4 consumed choices, 100–30000 ms/choice within the existing overall deadline. They bound fan-out, repeated-condition loops and retained stack time; they are not provider-version or quality gates. Boundary tests cover 0/1/8/9, 99/100/30000/30001 and four/five attempts. Eight real Lisp restarts pass the shipped TypeSafe serializer/parser fixture.

## Checks

| Check | Observed result |
| --- | --- |
| TypeScript | `npm run typecheck` passed |
| Focused current-source recovery | 10 passed; development + protected real SBCL |
| Existing complete Lisp suite | 333 total: 308 passed, 3 failed, 22 skipped |
| Skill compilation/snapshot delivery | 11 passed; original efficiency threshold retained |
| Fault injection in disposable copies | 4/4 detected by assertions: duplicate claim, stale identity, post-selection authority, UNKNOWN gate |
| Protected Python baseline comparison | Same 3 failures on unchanged HEAD and candidate |
| Final diff whitespace | `git diff --check` passed |

The three existing Python failures name `libxcrun.dylib` under `/Applications/Xcode.app`: the system Python launcher needs a path excluded by the existing protected policy. The baseline was extracted with `git archive HEAD` into `/tmp`, built with the same installed dependencies and tested with the same Node v26.5.0/environment. The sandbox source matches HEAD byte-for-byte. No OS sandbox policy was broadened. Native DSH/UI fixtures among the 22 skips remain unverified; historical cross-platform CI is not claimed as new work.

The additional runtime and boundary tests belong to the existing Lisp suite; no CI job or fixed benchmark threshold was added. The mutation reports represent targeted counterexamples, not exhaustive fault coverage.

Repeatable commands (all test databases/workers are disposable):

```sh
KIOKUKO_REQUIRE_LISP_RUNTIME=1 node scripts/run-tests.mjs tests/dsh/unit/lisp/recovery.test.ts tests/dsh/integration/lisp/recovery-runtime.test.ts
KIOKUKO_REQUIRE_LISP_RUNTIME=1 node scripts/run-tests.mjs tests/dsh/unit/lisp tests/dsh/integration/lisp
node scripts/run-tests.mjs tests/dsh/unit/skill-compiler.test.ts tests/dsh/unit/skill-snapshot.test.ts
npm run typecheck
```

## Final-source real-model observations

All payloads were bounded synthetic material. Existing credentials were resolved normally; no new key, configuration, user database, or running user session was changed. The final source-bound measurements used 25 requests (20 ordinary configured-model comparisons + 5 public Typed Decisions calls). Earlier bounded exploratory measurements used 65 requests; the first 20 had an invalid prototype inspection limit and are explicitly excluded from accepted workflow evidence. No failed external effect was retried.

The ordinary configured route used `qwen/qwen3.8-27b-abliterated-cyber:free`. Five interleaved trials per arm:

| Arm | Execution / correct | Safe selection | Unknown stopped | Complete inspection | Latency ms, min / median / max |
| --- | --- | --- | --- | --- | --- |
| unwound-error | 0/5 / 0/5 | 5/5 | 2/2 | n/a | 397 / 423 / 841 |
| live-restart | 3/5 / 3/5 | 5/5 | 2/2 | n/a | 2003 / 2065 / 2112 |
| direct | 5/5 / 5/5 | n/a | n/a | n/a | 401 / 422 / 428 |
| prototype-inspected | 5/5 / 5/5 | n/a | n/a | 5/5 | 418 / 420 / 431 |

Both recovery arms had zero duplicate counter effects. The live arm recovered all three cases with a supported continuation and aborted both UNKNOWN cases. The unwound arm cannot resume the lexical stack; this comparison demonstrates a mechanism difference, not general model superiority. Prototype/direct choices were both 5/5 correct on easy finite boundary problems. Prototype evaluation and full same-operation saved-result inspection are scripted; autonomous tool-use is not measured. Latency includes the worker/model path and excludes initial worker compilation; five samples do not establish a speed ranking.

The separate public path exercised `LispManager → worker RPC → DecisionService → TypeSafeDecisionProvider → real HTTP → shipped response validation`. The profile default requested `jev-latest`; all five responses identified `jev-1.13.0`. All three supported continuations were selected and returned correctly; both UNKNOWN cases were abstained, with zero duplicate counters. Latency min / median / max: 151 / 160 / 243 ms. This uses the existing DSH local credential service and its stored reference. It reads profile settings or shipped defaults, not persisted user-DB provider selections. It proves that product contract under a fixture host, not installed native UI operation or broad Lisp quality. Confidence is not treated as correctness.

## Source, generated artifact and user runtime

The JSON binds current Lisp/TypeScript/test/evaluator source hashes. Both final live measurements built and used the same development cache key `b83d85fb817a579ba6cb1e1ee9e3569ac7eb198d50e771f20c0be17b1f5007d7`. A separate protected FASL was generated in `/tmp`, validated by its manifest, and executed in a real protected worker (API present, value 42). Its SHA-256 is `5c1ff482dbaf6f0fb802f4b5b27d9199926bb54a583d1b0c35058640d8d6a25c` (6794503 bytes). These are temporary test artifacts; the preserved manifest is evidence, not a deployed binary.

The installed `dist` output and user processes were not rebuilt, reloaded or stopped. No commit, push, credential/configuration change, durable user-DB mutation or DSH/deepseek-harness source edit occurred. Full native UI integration, autonomous tool usage and general quality remain unmeasured. No arbitrary restart-body verifier or permanent heap recovery is claimed.

During verification, the first standalone artifact probe used the `/tmp` symlink spelling and was correctly rejected by the existing canonical-root contract; using `realpath` fixed the probe without a product change. Added Skill prose briefly exceeded the unchanged efficiency budget; that prose was removed, preserving the original Skill. Neither exploratory failure is counted as a product improvement.
