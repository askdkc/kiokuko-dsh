# Stop reservation and completion verification

Base: `492ce40ca75ce60fd6c7acfffb22b7a31c90a60b` plus the working-tree changes below. Environment: macOS arm64, Node 26.7.0, installed official DSH `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` (0.2.2-alpha.2). This is not an e8f7b93 runtime verification.

## Change and invariants

`src/dsh/harness/factory.ts` consumes the scheduling wake when reserving a driver and preserves that driver's AbortController for its first turn. Subsequent turns allocate a fresh controller. A later followup keeps its wake across an aborted first turn. `cancel()` aborts in `finally` even when inbox persistence throws, without swallowing that error. Ordinary discard clears the old wake; disposal prevents further input. An already aborted reservation is checked before the disposed-state loop guard, so immediate disposal records `aborted`, not `completed`.

No step cap, automatic retry, provider replay or new background scheduling was introduced. Existing work beyond 128 steps still passes. After an ordinary completed turn the drain loop continues only for pending wake/next-turn input; without it the driver settles to idle.

## Regression evidence

Seven added native harness tests failed on the original source, then passed after the correction:

- Same-tick followup/Stop: zero provider requests, aborted turn, retained input only with keepInbox (two cases).
- Provider in progress and failing inbox mutation: signal aborted, exact original persistence error propagated (two cases).
- Same-tick followup/Stop/new followup repeated 100 times for both retention policies: every expected message accepted exactly once, correct order, 100 aborted reservations, no empty completion turns, at most one concurrent provider (two cases).
- Immediate disposal: no provider request, no accepted new input, empty inbox and aborted turn (one case).

The proposed controller/wake correction alone initially left the disposal reason as `completed`; the early abort check fixes that additional case.

Final command:

```sh
node --import tsx --test \
  tests/dsh/integration/kiokuko-harness.test.ts \
  tests/dsh/integration/kiokuko-harness-transport.test.ts \
  tests/dsh/integration/coding-input-retry-native.test.ts
```

**65 tests passed, zero failed or skipped**, including 57 harness/transport tests and eight real file edit → failed subprocess test → repair → passing test variants (public/adapter, recording DB available/unavailable, color unset/on). The eight coding variants additionally check idle status, empty input queues, completed turn reason and unchanged execution events/provider-call count after completion. The observation window is 40 ms; the pure harness stress tests also verify stable idle after queued work drains.

An initial completion assertion counted auxiliary LLM calls and failed (12 versus 11). The corrected check uses the official `isAgentLoopRequest` marker and checks turn/step/request/tool events independently. Auxiliary post-turn memory work is not counted as a restarted coding loop. These tests do not claim that all post-turn auxiliary activity ceases.

The native model provider is scripted. Real-model behavior, interactive macOS UI, and real Lisp coding were not tested by this focused suite.

## Local CI attempt

```sh
KIOKUKO_TEST_TIMEOUT_MS=30000 npm_config_fetch_retries=0 \
npm_config_fetch_timeout=10000 node scripts/verify.mjs --profile main \
  --output /tmp/kiokuko-stop-ci
```

The verifier reached a terminal result for all 24 checks: **13 passed, 10 failed, one prerequisite missing**; exit code 1, completionReady false. The per-test deadline is an explicit local bound, so this is not an unmodified hosted CI run. Typecheck, build, publint and harness evaluation passed. The final report precedes only this documentation addition; the tested implementation/tests remain unchanged.

Observed blockers include `/bin/ps` and socket `EPERM`, `sandbox-exec` refusal (protected-python3 prerequisite), registry `ENOTFOUND`, and a 180-second packed-consumer installation deadline. No access restriction was bypassed. The broad failures remain failures, not inferred passes. Full CI success and e8f7b93 compatibility remain unverified. No commit, push or deployment was performed.

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

## Tested source identities

- `src/dsh/harness/factory.ts`: SHA-256 `abf68c12937e4813cb42f138e5c2bfcb677313fc17f8c5987daf30f5d441b892`.
- `tests/dsh/integration/kiokuko-harness.test.ts`: SHA-256 `3fb5573b0f8127a2d6c79cb8071eba4e3bd79c811fc88e7b77e2303f1a23a3f7`.
- `tests/dsh/integration/coding-input-retry-native.test.ts`: SHA-256 `7ead2bf736fa2b04eb55856c4041d6cc901f7c449c7e40f6d424da35cc409e90`.
