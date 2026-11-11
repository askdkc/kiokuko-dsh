# Coding continuity implementation status

2026-11-12. Base: 47ea860b. DSH inspected: f3803c9.

Implemented: optional input-claim database acquisition is bounded at 250 ms;
expired callbacks cannot begin writes; synchronous optional SQLite work uses a
25 ms busy timeout and restores the original setting. Memory quarantine now
retires native memory_explain results without acquiring the database, preserves
ordinary tool evidence and original audit events, and reports unavailable
validation rather than falsely claiming memory was forgotten. Efficiency
observations include runtimeContextCopies and runtimeContextBytes (sum of UTF-8
serialized matching user messages; existing totals are unchanged).

Validation: typecheck passed. Final combined intake, answer-context, auxiliary
database, efficiency and cold-resume selection: 209 passed, no skips/failures.
The subsequently expanded auxiliary database file: 5 passed, including native
surface explanation retirement, ordinary evidence preservation and idempotency.
Earlier harness/auxiliary recovery/efficiency selection: 62 passed.
These selections overlap and must not be summed as unique coverage.

Legacy runtime normalization is now implemented through individual native
user/message replacements with short non-runtime markers. It runs after SessionStore
entry and before agent publication, setup and pre-step pressure checks. It adds no
new awaited startup operation. Markers remain measurable input; this is not deletion.

Current validation: 62 tests passed across harness, transport, cold recovery,
auxiliary database, efficiency and runtime projection, with zero failures/skips.
Typecheck and complete package build passed. The new regression restores 51 legacy
snapshots interleaved with 50 actually executed tool results, checks the native token
meter and final request each retain one runtime snapshot, and checks real automatic
compaction issues zero summaries. Original audit events and tool results are preserved.
A seed containing only 17 persisted replacements converges on recreation; a second
normalization adds no events. In a disposable source copy with only the migration
call disabled, the same regression fails with 51 !== 1 (after resolving a missing
scripts fixture link); the unchanged production implementation passes.

Unverified: official persistence process-crash recovery specifically combined with
legacy normalization, old DSH compatibility, actual Lisp/PTC/model/UI end-to-end paths,
full CI, pending DB operation drainage and repeated timeout capacity. The existing
cold-recovery test passed but does not prove that new combined scenario.
Timeout stops awaiting acquisition, not the underlying promise.
No commits, dependency modifications or runtime reload were performed.

Commands: npm run typecheck; node scripts/run-tests.mjs with
tests/dsh/unit/{on-demand-review-regressions,auxiliary-database,answer-context-boundaries,efficiency}.test.ts
and tests/dsh/integration/session-recovery-native.test.ts.
