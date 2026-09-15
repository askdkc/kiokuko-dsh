# Enno memory refresh evaluation

Baseline: `d4e61126228acb043f6b182a9c4f9bab7ccb146a` (0.1.53).
The implementation retains default `off`; Rerank is not adopted.

## Reproduce

```sh
npm run test:enno-memory
npm run test:benchmark:enno-memory
npm run test:evaluation:enno-memory

# Supply an isolated installation from tests/fixtures/dsh-runtime/package-lock.json.
KIOKUKO_DSH_PACKAGE_ROOT=/absolute/path/to/fixture/node_modules \
KIOKUKO_REQUIRE_DSH_NATIVE=1 npm run test:enno-memory
```

Without the pinned DSH packages, the native tests report a skip. That skip is not evidence
that the request path works. Evaluation makes no provider calls and reports `unmeasured`.

## Fixed comparisons

- A: `off`, existing intake and final request fences.
- Observe: same selections as A, decision-only observation.
- B: `active`, semantic difference detection and Reuse / Full, lexical search.
- C: not implemented; there is no evidence yet that Rerank improves selection or cost.

The integration fixture has 200 initial candidates and separately asserts that
`E_LOCK_TIMEOUT` memory is absent from that candidate set. B retrieves that memory after
new evidence, retaining its applicability and boundary text. A and observe do not change
context. Repeated evidence does not increase the additional Full count.

The scripted model runs through the actual pinned DSH agent loop and persistent worker,
including phase transitions, repeated tool failures, native compaction, supersede and
terminal completion. Tests inspect the final request messages, all three permitted origins,
private-workspace exclusion, original human input and visible final response.
The scripted model and its synthetic usage counters cannot establish real-model quality or billed tokens.

## Measured scope and limits

The benchmark uses disposable 20, 1,000, 9,999 and 10,001 entry corpora. Each mode uses the
same task and corpus contents. The initial candidate selection precedes corpus expansion
in all modes; a first boundary establishes the comparison baseline. Five subsequent
boundaries include the new-error boundary and four repetitions. Output retains the samples,
p50, p95, maximum, corpus probe cost, broker stages, discard reasons and call counts.
These five samples are descriptive, not a confidence interval or a universal speedup estimate.
The 10,001-entry case checks the existing integrity limit and safe degradation.

Real-model Recall@5, task success, incorrect applications, total completion time and billed
token savings remain **unmeasured**. The benchmark does not use a production database,
user history, remote provider or artificial semantic vector.

## Local measurements (2026-09-16)

Node v26.5.0, macOS, fixed lexical fixtures, 8,000-character presentation budget and
5,000 ms cooperative refresh budget. Five measured boundaries per cell, including one
new-error boundary. Raw samples and stage timings: [benchmark JSON](enno-memory-benchmark.json).
These are refresh-service timings, not complete task or model-request timings.

| Corpus | Active p50 / p95 / max (ms) | Separate corpus probe (ms) | New error memory | Additional Full reservations |
| ---: | ---: | ---: | --- | ---: |
| 20 | 35.08 / 50.65 / 50.65 | 4.98 | Delivered | 1 |
| 1,000 | 862.86 / 965.08 / 965.08 | 283.77 | Delivered | 1 |
| 9,999 | 6,930.70 / 6,955.57 / 6,955.57 | 2,224.30 | Omitted: time budget | 5 |
| 10,001 | 46.29 / 54.79 / 54.79 | 44.20 | Omitted: existing corpus limit | 0 |

Off p95 was at most 0.008 ms and observe p95 at most 0.048 ms for the optional service
alone. Neither calls retrieval nor computes an extra corpus hash. The separately timed
corpus probe is a benchmark measurement, not work performed by off/observe.
Every cell added zero LLM, embedding and remote calls. After successful selection in the
20/1,000-entry cells, four repeated boundaries added zero Full searches.

The 9,999-entry cell discarded all six attempts including the baseline boundary. Five
new-error attempts consumed five reservations despite being discarded; failures do not
refund the budget. The repeated failed attempts demonstrate the bounded retry cost, not
successful reuse. At 10,001 entries the existing integrity limit prevented reservations.
The 5-second budget is cooperative and can be exceeded by synchronous work. The default
1-second budget has less headroom; these results do not establish a supported corpus size
or a speed improvement. No confidence interval is claimed from five samples.

## Verification scope

- 19 dedicated tests passed with the pinned native DSH runtime, zero skipped. These cover
  off/observe/active, the initial 200-candidate miss, new-error discovery, repeated evidence,
  phase rebinding, verifier timeout evidence reaching Zenki, compaction restoration,
  allowed origins, private exclusion, supersede, durable reservations, cancellation,
  stale ownership, current lease/capability checks, configuration changes, owner eviction,
  required embedding failure, optional observer failure and DB failures.
- Delivery-transaction failure and process-local cache loss are injected at service/store
  boundaries. This does not claim operating-system process termination at every instruction
  between native insertion and acknowledgement.
- The native fixture inspects 12 parent requests and four failed tools per mode, with a
  visible final response and terminal contract/worker state. Copy counts and compaction
  restoration are asserted from request bodies; they are not separate production observer
  counters. No Rerank pool or pool-eviction metrics are implemented.
- Real provider comparisons remain unmeasured. `test:evaluation:enno-memory` reports that
  fact without reading credentials or making a provider call. Default remains off.

### Regression and delivery checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed after the final source change |
| Native-required `npm test` | 719 tests: 718 passed, one CLI installation environment failure, zero skipped |
| Failed CLI installation test recheck | One passed, zero skipped, using isolated pnpm 11.25.0 and network access |
| Final `test:enno-memory` | 19 passed, zero skipped, including the additional owner-eviction regression |
| Forward-migration recheck | Nine passed, including older pending runs and receipt identities |
| `npm run test:sampledb` | Baseline initialization and DSH runtime resume passed |
| `npm run build` | Passed after the final source change |
| `npm run pack:check` | Import, client artifact, relative module closure and migration inclusion passed |
| `npm run publint` | Auto-selected Corepack/pnpm failed before linting; isolated npm packing passed |
| DSH CLI/Web lifecycle | Install, authenticated HTTP routes, client bundle, reload and uninstall passed |

The full test run includes the evolution and continuity suites. Its CLI failure was
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` in the local Corepack launcher. Direct fixed
pnpm removed that failure; dependency installation additionally required network access.
Neither the user package-manager configuration nor installed plugin was changed.
The initial seven migration expectation failures were corrected and the nine related
tests rerun before the final broad run.

The `test:e2e:dsh` native composition and repeated-lifecycle stages passed with no skips;
its final CLI stage hit the same environment problem. Only the CLI lifecycle functions
were rerun after fixing the isolated test environment. They used the actual packed
0.1.53 working tree and DSH **0.1.5-rc.1**, a disposable profile/workspace, redirected
Skill deployment and temporary caches. Web evidence verifies the served JavaScript and
HTTP routes, not manual visual operation of the browser UI. This is not validation of
DSH 0.1.6-alpha.1 or a published npm release.

For this environment, publint was completed with:

```sh
npm_config_cache=/private/tmp/kiokuko-enno-publint-cache npm run publint -- --pack npm
```

All source changes remain uncommitted. The baseline commit identifies the starting tree,
not a release containing these changes. `PLAN.md` is locally updated and remains ignored
by the existing repository configuration.
