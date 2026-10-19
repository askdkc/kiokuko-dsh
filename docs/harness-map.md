# Harness implementation map

Use this map to find the current entry point and a focused check before editing. It is a repository index, not text automatically injected into a model request.

| Concern | Entry and owner | Focused checks |
| --- | --- | --- |
| Task admission and execution choice | `src/dsh/intake-gate.ts`, `src/dsh/host-adapter/admission.ts` | `node scripts/run-tests.mjs tests/dsh/unit/task-completion.test.ts tests/dsh/integration/turn-process.test.ts` |
| Advisory decision provenance and diagnostics | `src/dsh/decisions/diagnostics.ts`, `src/dsh/decisions/service.ts`, `src/dsh/on-demand-intake.ts`; [contract](decision-diagnostics.md) | `node scripts/run-tests.mjs tests/dsh/integration/decision-diagnostics.test.ts tests/dsh/integration/decision-diagnostics-native.test.ts tests/dsh/integration/turn-process.test.ts` |
| Independent intent comparison and finite-domain judge | `src/dsh/decisions/intent-assessment.ts`, `src/dsh/decisions/micro-judge.ts`, `crates/micro-judge/src/main.rs`; [contract](micro-judge.md) | `KIOKUKO_REQUIRE_MICRO_JUDGE=1 node scripts/run-tests.mjs tests/dsh/integration/micro-judge.test.ts tests/dsh/integration/request-intent-clarification-native.test.ts` |
| Task conditions and structured file scope | `src/dsh/execution-frame.ts`, `src/dsh/execution-support.ts` | `node scripts/run-tests.mjs tests/dsh/unit/execution-support.test.ts` |
| Normal and Enno completion evidence | `src/dsh/task-completion.ts`, `src/enno-oduno/service.ts` | `node scripts/run-tests.mjs tests/dsh/unit/task-completion.test.ts tests/dsh/integration/final-verification` |
| Durable continuation and recovery | `src/dsh/turn-process.ts`, `src/dsh/boundary-worker.ts` | `node scripts/run-tests.mjs tests/dsh/integration/boundary-worker.test.ts` |
| Memory selection and application | `src/dsh/message-sources.ts`, `src/dsh/memory-application.ts` | `node scripts/run-tests.mjs tests/dsh/integration/memory-application.test.ts` |
| Context projection and provenance | `src/dsh/context-projection.ts`, `src/dsh/agenticreplay-event-mapper.ts` | `node scripts/run-tests.mjs tests/dsh/unit/agenticreplay-request-manifest.test.ts tests/dsh/integration/continuity` |
| Native permissions and tool results | `src/dsh/tool-policy.ts`, `src/dsh/task-completion-host.ts` | `node scripts/run-tests.mjs tests/dsh/integration/tool-exposure-native.test.ts` |

The full validation path is `npm run typecheck`, `npm test`, `npm run build`, `npm run test:harness`, then the native and package checks. Run suites that rebuild or read the shared `dist/` sequentially.
