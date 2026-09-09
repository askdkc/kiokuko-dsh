# DSH token efficiency

Exact duplicate title/summary/body fields and redundant tool-description wording are removed without changing business schemas, context deliveries, selection, authorization, or native history. Distinct summaries, exceptions and body text remain visible. Results were already compact JSON.

## Optional evaluation settings

```yaml
- id: kiokuko-dsh
  config:
    efficiency:
      observe: true
    finalization:
      inputMode: prefix_reuse # prefix_reuse (default) | bounded_evidence
```

`observe` defaults to false. When enabled, the host exposes `host.efficiency.snapshot()` for an evaluation harness. The snapshot contains bounded, in-memory numeric observations (at most 2048 calls); no prompt, response, reasoning text or credentials are stored. It does not start Orca recording or persist a usage ledger. Request bytes describe serialized DSH inputs, not a verified provider wire payload or token count. Counters cover observed streams, including available child and auxiliary attribution; provider-internal retries are unknown. Evictions, missing attribution and observation errors are explicit. Restart clears observations.

DSH input/cache counters are disjoint. Logical input is calculated only when all three counters are known; reasoning is reported separately and never added to output again. Missing usage remains unknown. Finalization observations are emitted after extraction/storage settlement, including failures, and are excluded from the global stream observer to avoid double counting. Observations cannot veto native completion.

`bounded_evidence` is experimental. It uses target-run evidence including messages still on the native surface, reserves the latest evidence of each supported kind, and omits copied main-agent system/tool definitions. Per-event excerpts and the overall evidence size are bounded; large records may lose detail. Plugin snapshots and compaction summaries that could mix earlier runs are excluded. The existing full-log digest and capsule verification/storage policy remain in effect. Missing context budget, empty evidence or a larger serialized request falls back to `prefix_reuse` before calling the model. There is no automatic second model call after failure.

Keep `prefix_reuse` for normal use until paired real-model evaluations confirm memory quality and total token/cost improvement under cold and warm caches. Both modes keep the selected provider/model/reasoning settings and output allowance. The requested mode is saved with each finalization job, so retry/reload cannot silently change it. Existing jobs migrate to `prefix_reuse`; a configuration change applies to newly scheduled jobs. A 256 KiB stream-text bound precedes the existing 64 KiB capsule validation.

Explicit hosts must implement `configureEfficiency` to accept non-default settings; unsupported settings fail visibly rather than appearing enabled. Native adapters expose this interface. The finalizer must be configured before starting or scheduling it.

## Verification

```sh
npm run typecheck
npm test
npm run test:efficiency
# Requires the pinned DSH 0.1.2-rc.1 CLI/runtime, using a disposable profile:
KIOKUKO_REQUIRE_DSH_CLI=1 npm run test:e2e:dsh
```

`test:efficiency` uses synthetic inputs and makes no provider calls. It prints schema, memory and finalizer-request byte comparisons; token and cost savings remain null. It can save JSON with `-- --output report.json`. Native loop tests use the actual pinned DSH runtime with scripted model responses; they establish workflow compatibility, not live provider costs or memory quality.

### Verified on 2026-09-09

The uncommitted working tree based on `6395f464f5ec6fe25e0c803622dbca9918f69dcc` was tested with Node 26.5.0 on macOS and DSH 0.1.2-rc.1:

- Full suite: 360 passed, 0 failed, 0 skipped with the real DSH runtime enabled. This covers native execution, delegated children, restart/retry, migration of pending jobs, finalization failures and observation isolation.
- Dedicated native E2E: 16 passed, 0 failed, 0 skipped with scripted model responses, including both finalization modes.
- Packaged lifecycle: installation into a disposable Web profile, new configuration validation, authenticated Web/bootstrap and browser-bundle loading/materialization, then successful removal. This is an automated runtime/bundle check; it does not establish interactive browser behavior or live-provider memory quality. The existing user profile was not changed.
- Typecheck, build, package import/dependency checks, publint and whitespace checks passed. Retrieval evaluation passed all gates across 110 queries (Recall@1 0.93, Recall@5 0.99, scope leakage 0).

The packaged lifecycle artifact had integrity `sha512-o1eRC/puGlFbIvcVWRie1ypbE+X0qabm3WheBcFe5VfL15jlgWcbgdFl8c8iVD35zdge7afif1O8JxNbGZpOwA==`. It was a local test package, not a published release.

[Synthetic comparison results](./token-efficiency-evaluation.json) show tool definitions at 28,117 → 27,130 bytes and identical summary/body presentation at 174 → 93 bytes; distinct exception text stays at 104 bytes. The bounded finalizer fixtures shrink substantially, but intentionally excerpt oversized evidence. Real token counts, total billed cost and generated-memory quality remain unmeasured, so `bounded_evidence` remains opt-in.

To roll back the experimental input mode, select `prefix_reuse` for new jobs. Jobs already scheduled retain their immutable mode. Disable observation with `observe: false`. Do not restore an old database backup as a feature rollback or assume binary downgrade is compatible with the new migration.
