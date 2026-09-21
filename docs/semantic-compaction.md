# ObservationPack and semantic compaction

Kiokuko reduces old tool output through the existing native compaction coordinator. The order is ObservationPack, native token-meter measurement, Jev semantic selection, then DSH's own automatic handling. Original events remain in the native append-only history; no additional database or migration is needed.

Both the full plugin and standalone core default to:

```yaml
observationPack:
  mode: auto
semanticCompaction:
  mode: auto
  preemptive: true
  budgetMs: 5000
```

`observationPack.mode: off` stops new packing while keeping historical handles readable. `semanticCompaction.preemptive: false` disables only TODO-boundary decisions; pressure-triggered semantic compaction remains enabled. `semanticCompaction.mode: off` disables both semantic paths without disabling ObservationPack. Native automatic-compaction disablement prevents automatic packing and semantic shortening. Restoration of inaccessible packed output still runs before the next request.

## ObservationPack

Successful native `read`, `glob`, `grep` and foreground `bash` results containing a single plain text block larger than 10 KiB remain full for two completed native model calls after their result event. Failed attempts and interrupted assistant messages do not count. Before a later request, packing replaces the display with its original byte count, digest, stable session-bound handle and complete head/tail lines totaling at most 1 KiB. The envelope adds metadata beyond that excerpt budget. ObservationPack makes no Jev call.

Failures, unknown success, background execution, Lisp and execution-control results are excluded. Bash additionally requires a captured structured foreground exit status of zero, without interruption or sandbox failure, and an exact match to the logged presentation. `isError: false` alone is insufficient. After reload, Bash results without that live proof remain untouched.

The auxiliary native tool is separate from Enno business operations:

```ts
observation_read({ handle, offset: 2000, limit: 2000 })
// { text, nextOffset: number | null, characters, bytes, digest }
```

Offsets count Unicode code points. The default and maximum page size are 2,000 characters; offsets beyond the original end and additional input fields are rejected. No file path or session ID is accepted. Native permissions and the exact active session binding apply. Lisp retains this read capability through its existing permission fence and pins its implementation. Handles continue to work with packing disabled. Parent-session handles cannot read from child sessions; inherited packed displays are restored to their originals before child requests.

Packing requires the original reader definition to be visible in the assembled tool surface. If access disappears, owned packed displays are restored before the next model request. If restoration cannot be authorized or committed, the step stops instead of sending inaccessible references.

## Jev decisions

The existing [typed-decision backend](typed-decisions.md), credentials, readiness probe, configured provider/model, acceptance criteria and persisted decisions are reused. No provider substitution or automatic retry is added. Missing Jev readiness does not disable independent ObservationPack or native DSH handling.

A preemptive boundary occurs when consecutive native `todo/write` snapshots change an existing item's unchanged `content` from `pending` or `in_progress` to `completed`, with unfinished work remaining. Initial completed items, renaming, reordering, duplicate notifications and final completion do not trigger it. Each boundary is consumed once at the following pre-step. Reconnection starts from the current history tail; it does not replay old boundaries.

After packing, the native token meter must predict at least a 25% reduction of the total request, including pending input and native overhead, and a result below the routed model's native threshold. A qualifying TODO boundary can run below the current threshold. Without a boundary, the existing pressure gate applies.

One logical batch combines the timing decision (`compact`, `defer`, `uncertain`) with candidate decisions (`keep`, `shorten`, `uncertain`). Transport splitting obeys existing limits, preserving complete required evidence in every part. Only accepted `compact` plus accepted `shorten` selections can commit. The selected subset must independently satisfy the savings gate. Current task text, TODO changes, remaining work, candidate status and excerpts are supplied; oversized or sensitive required evidence causes a fallback.

Semantic selection preserves user/assistant messages, tool calls, the first six and newest six surface messages, and ambiguous, multimodal or previously replaced results. It considers up to 64 eligible results longer than 1,024 Unicode code points. The preemptive path also preserves results not yet presented in two completed native calls. Native manual and overflow recovery retain their existing authority. Normal results keep a 300/100-character head/tail excerpt; Lisp's existing projector preserves outcome metadata and inspection references.

## Integrity and evidence

The coordinator rechecks native session/agent identity, execution authority, history, configuration, routed model and cancellation before appending. Original native results reference their tool-call events; replacement results reference earlier tool-result events. These are distinct, preventing both accidental exclusion of ordinary results and repeated shortening.

Replacement uses native `compaction/prune` followed by `tool/result` surface replacement. Appends are not atomic: failure stops the current step, reports landed replacements/events and prevents a blind retry. Orphan prune markers remain excluded after reload. Inspect native history before recovery.

Memory selection uses original events within its existing evidence limits. Display replacements are not new executions; review and evolution retain original sequence/hash bindings. Observation retrieval is not independent verification. Packed conversation displays remain explicitly incomplete evidence.

Inspect status with:

```text
/kioku-decisions status
/kioku-decisions probe
```

Status includes the preemptive setting/activation, last boundary outcome and skip reason, plus numeric packing/restoration counts, original/packed byte totals, reader calls/bytes and reader-schema size. Native stream observations also report serialized request-attempt bytes, tool-definition bytes and attempt counts; a failed connection may mean an attempted request was never sent. Semantic provider metrics count actual dispatches, serialized batch bytes, elapsed time and reported token usage when available. Cached decisions do not increment dispatch counts. Metrics retain no tool bodies, reset when the service is recreated, and do not estimate billing or counterfactual bytes saved across future requests.

## Verification

The pinned native DSH fixture executes real file reads, Unicode middle-page retrieval and a subsequent file write. It also exercises actual native TODO transitions, reader disappearance/restoration, and existing manual/overflow behavior. Focused tests cover failures, partial appends, provenance, cancellation, configuration, child bindings and decision fallbacks.

```sh
npm ci --prefix tests/fixtures/dsh-runtime
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
  node scripts/run-tests.mjs tests/dsh/unit/semantic-compaction tests/dsh/integration/semantic-compaction tests/dsh/integration/lisp/read-surface.test.ts
npm run typecheck
npm test
npm run build
npm run publint
npm run pack:check
npm run test:modules
```

The native packing test prints enabled/disabled request JSON bytes, including tool definitions and the extra retrieval request, for the same final file-writing task. Its model and classifier are scripted. Native token-meter projections, serialized bytes, provider-reported tokens, actual billed cost and live-model task success are different measurements. No live judgment-quality, cost or success-rate improvement is claimed.

## Local Laya

[Laya-CoreML](laya-coreml.md) preflights every complete one-question part before
starting any prediction for the compaction batch. This uses the actual tokenizer
instead of the legacy byte-minus-512 estimate. A later part that does not fit
prevents all predictions for that batch; an independent readiness probe may have
already run. Preflight is not counted as a model prediction. Capacity rejection
retains service readiness and uses the existing compaction fallback.
