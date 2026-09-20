# Semantic compaction

Kiokuko can shorten selected old tool results before DSH's automatic pressure compaction. It uses the existing typed-decision backend; it does not require `fast-jev-compaction` or changes to DSH.

```yaml
semanticCompaction:
  mode: auto       # auto (default) | off
  budgetMs: 5000   # readiness, queueing, evaluation and preparation
```

This configuration belongs to the full plugin or the modular core. Enable and configure [typed decisions](typed-decisions.md). TypeSafe uses `TYPESAFE_API_KEY` or the native credential configured by `/kioku-typesafe-key`; a generic `API_KEY` is not used. Nimble uses its configured endpoint, model and optional native credential reference. Credential presence alone is insufficient: the backend must pass its readiness probe. `/kioku-decisions status` reports configuration, readiness, native support and the last bounded compaction outcome. `/kioku-decisions probe` explicitly refreshes readiness.

Coverage:

| Execution | Coverage |
| --- | --- |
| Normal | Native conversation tool-result history |
| Enno | Main agent across role changes and explicitly bound native workers, including restored workers |
| Lisp | Native conversation and supported rendered `lisp_eval` data; stored values and Lisp runtime state remain intact |

Direct auxiliary `llm.stream()` calls have no native conversation history and are outside this feature. Manual `/compact` and context-overflow recovery use DSH's existing behavior.

## Protection and fallback

User and assistant messages, every tool call, the first six and newest six surface messages remain unchanged. The plugin only considers unambiguously paired results with one plain text block longer than 1,024 Unicode code points. Multimodal, unfamiliar, previously replaced and orchestration control results remain unchanged. At most 64 candidates are selected by estimated savings, with surface-order tie breaking.

The backend chooses `keep`, `shorten` or `uncertain`. Only accepted `shorten` results authorize changes. Ordinary output retains its first 300 and last 100 Unicode code points, with an omission marker. Lisp uses an internal 1 KiB rendering profile that reduces supported display data and preserves outcome metadata, change summaries and inspection references. Protected metadata can prevent Lisp reduction entirely.

The classification view contains redacted task/context text, bounded tool arguments, result statuses, sizes and excerpts. It excludes attachment bytes, provider replay state and raw provider responses. Every batch retains required evidence. Oversized evidence falls back rather than silently dropping required context; this is especially conservative for Nimble's smaller prompt limit. Classification input compression does not count as request savings.

Before any append, native token-meter projections, including pending input and request overhead, must show at least a 25% reduction and a result below the exact routed-model threshold. The plugin rechecks session identity, execution authority, source history, cancellation and active compaction. Insufficient savings, unavailable authentication, provider errors, fitting limits or the deadline leave semantic history unchanged and continue native handling. Cancellation or integrity failures interrupt the step without committing semantic replacements.

Replacements use DSH's append-only `compaction/prune` and `tool/result` protocol, preserving original events and exact source references. Appends are not an atomic transaction: a commit-stage failure reports confirmed replacements and landed events, stops the step and suppresses automatic retry for that live session. Orphan prune markers are also excluded after reload. Inspect native history before recovery; there is no destructive rollback.

## Verification limits

Protocol tests use the pinned DSH 0.1.5-rc.1 fixture and scripted classifier responses. English and Japanese fixtures separately demonstrate stock summary compaction versus a smaller semantic request that avoids summary and survives reload. Missing native prerequisites fail the new integration suite.

For a fresh checkout, install the fixture before running the tests:

```sh
npm ci --prefix tests/fixtures/dsh-runtime
node scripts/run-tests.mjs tests/dsh/unit/semantic-compaction tests/dsh/integration/semantic-compaction
```

These tests establish protocol behavior, not live classifier quality, cost or latency. No live-model benchmark is implied. Low-pressure steps make no classifier call. High-pressure calls share the existing typed-decision concurrency limit and the total configured deadline.
