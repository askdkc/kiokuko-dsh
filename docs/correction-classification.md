# Correction meaning classification (2026-10-21)

The implementation is complete as a shadow observation path. **Automatic production activation is not qualified.** Jev held-out special-rule precision is 86.54% and false-special rate is 7/75 = 9.33%; both miss the provisional release gates. No live configuration, installed plugin or production database was changed.

## Source and design

Fetched DSH baseline: `01e27576d2efe5020c19e93bdba1a6528bfcaee1`. Fetched Kiokuko baseline: `5289ed72e347e65eb9a17d8b1d90f51958f8b333`. These remain HEAD; the implementation is an uncommitted working-tree diff. Final file digests and command evidence are in `evaluations/correction-classification-2026-10-21/verification.json`.

`correctionSource` no longer infers meaning with language-specific regex. The common `correction-classification` finite Choice contract admits `capability_compatibility`, `reference`, and explicit `uncertain` abstention. Input contains title, full body and summary; a summary never replaces the body. The configured DSH DecisionService dispatches the same contract through TypeSafe/Jev, Nimble or Laya. Existing request-intent classification remains independent. Laya v1 cannot attest internal truncation/model identity; its results remain advisory even in explicit auto mode. Strict adapter preflight runs before this purpose's inference.

Classification is host-owned metadata in an additive `correction_classifications` table (DSH migration 045, Kiokuko 015), separate from memory/provenance. The key includes workspace, entry ID, revision, semantic-input digest, policy and provider-configuration digest. Persisted results contain the rule, bounded reason, provider/model metadata where exposed, timing and token counts; raw correction text is not duplicated. Input digests exclude classifier output. Source-evidence digests also bind original provenance. Caller provenance is neither a cache nor classification authority.

Generation/capture remains unchanged. First eligible retrieval classifies explicit `interaction_capture` / `user_correction` entries. Existing legacy and duplicate recaptures enrich the existing entry on first use without rewriting its content/revision or creating competing memories. Both DSH core task and full host-adapter retrieval paths pass their existing DecisionService. Delivery carries observed classification plus source identity. Application still requires existing delivered/observed-input evidence, current source checks, capability confirmation and machine-verified execution authorization. `compatibilityDecisionConflicts` and the execution gates are unchanged.

Before any cache hit, the current persisted entry must match revision, full evidence, correction provenance, status and workspace. The same check runs inside the publication transaction after asynchronous inference. Deleted or changed entries return stale/uncertain; no obsolete result is published. Concurrent identical lookups on one connection share inference. Valid cache reuse works across reopening the database. Corrupt cache metadata fails closed.

Timeout, malformed output, provider outage, unsupported input and semantic abstention stay explicit and never become `reference`. Caller cancellation persists nothing. Successful and failure results are cached for unchanged keys; transient outages are not automatically retried until the host changes the cache/configuration/policy key or explicitly clears its own failed cache row. This deliberately avoids repeated model calls and is an operational limitation. There is no permanent regex fallback.

Default mode is `shadow`; optional host configuration is `typedDecisions.correctionClassification.mode = off | shadow | auto`. Global Typed Decisions off suppresses inference. In shadow, unavailable, stale, uncertain, off or insufficiently attested cases, exposed `source.rule` is `uncertain`, so special machine handling cannot start. An explicit auto option exists for controlled tests/experiments, but these results do not qualify it for production. A semantic label never grants execution authorization.

## Kiokuko host boundary

Kiokuko has no existing DSH DecisionService or standalone semantic-provider configuration at this baseline. Its shared contract/cache implementation is byte-identical to DSH, and its strict MCP wire schema accepts uncertainty and classification metadata. A trusted configured host can reuse its existing neutral backend with:

```ts
const classifier = createCorrectionEnrichment(cacheRuntime, configuredDecisionBackend, 'shadow')
const server = createChatgptMemoryServer(owner, {correctionClassifier: classifier})
```

`cacheRuntime` is an explicitly host-owned writable cache connection; `owner` keeps the MCP profile's original access boundary. Provider configuration/credentials remain owned by the host, not MCP tool arguments. The live test supplies the existing configured DSH backend across this interface. Standalone Kiokuko CLI does not silently acquire a provider or credential configuration: absent injection it returns explicit uncertain/unavailable. This is a working injectable semantic integration, with a standalone default limitation; removing regex alone is not claimed as automatic provider parity. Main MCP keeps `modelInput: unobserved`, `verification: unverified`, and `authorizationGranted: false`.

## Timing decision

The final-source Jev prototype used two new synthetic entries, 20 unchanged repeated reads, and one changed entry, all in a disposable database. Capture-time classification took 233.71 ms total (write 4.67 ms, inference 229.04 ms, 571 input tokens). First-use capture took 2.96 ms; its cold lookup took 155.61 ms (570 input tokens). Twenty cached reads averaged 0.949 ms and made zero provider calls. A changed entry caused one call (160.63 ms); retaining the old entry object returned stale.

First use was selected: capture stays independent of inference; corrections never retrieved incur no provider call; unchanged reads use durable metadata. These sequential point measurements justify the workflow choice, not a general throughput or model-speed claim. Actual full body remains subject to adapter admission; rejected/truncated-unattested inputs cannot become authoritative.

## Live quality measurement

Existing authorized TypeSafe/Jev configuration was used with a process-local credential reference; no credential, private correction memory or persistent configuration was copied into evidence. Model: `jev-1.13.0`; policy: `correction-meaning-v1`; TypeSafe minimum confidence: 0.8. Development: 25 aligned cases across 5 semantic families, 25 correct. Held-out: **120 cases across 24 distinct semantic families and five aligned languages**; 45 special, 60 reference, 15 genuinely uncertain. Aligned translations are not 120 independent meanings. No held-out threshold/prompt tuning was performed.

Coverage includes positive paraphrases without version words, indirect and mixed-language wording, negation, quotations, opposing opinions, explanatory text, factual version/capability records, legitimate compiler minimums, reproducibility pins, CI prerequisites, runbooks, short/long input and lossy/contradictory summaries. The frozen historical regex remains only in the benchmark. It misclassifies relevant positives and hard negatives in the same corpus; it is never a production compatibility path.

| Metric | Jev held-out | Frozen regex |
| --- | --- | --- |
| Three-class accuracy | 107/120 = 89.17% | 52/120 = 43.33% |
| Special precision | 45/52 = 86.54% | 5/19 = 26.32% |
| Special recall | 45/45 = 100% | 5/45 = 11.11% |
| False-special rate | 7/75 = 9.33% | 14/75 = 18.67% |
| Abstention rate | 21/120 = 17.50% | 0/120 |
| Provider failure rate | 0/120 | 0/120 (no provider) |
| Classified coverage | 99/120 = 82.50% | 120/120 |
| Accuracy conditional on classified output | 92/99 = 92.93% | 52/120 = 43.33% |
| Mean / p50 / p95 latency | 165.69 / 157.47 / 210.28 ms | 0.000181 / 0.000145 / 0.000269 ms (CPU only) |
| Input tokens | 71,438 total; mean 595.32; reported 120/120 | 0 |

Accuracy counts abstain-on-gold-uncertain as correct: 15 of 21 abstentions are correct uncertain results; six are misses on gold reference. Thus 107 correct can exceed 99 classified outputs. Provider failures are separate from genuine uncertainty and never score correct. Positive abstentions/provider failures count as recall misses. The false-special denominator includes **all 75 gold non-special cases**, including 15 uncertain cases. Zero denominators are `null`, never a success.

Regex CPU timing used 20 warmups and 1,000 repetitions per each of the same 120 inputs. Repetitions add timing samples, not semantic coverage; CPU timing is not directly comparable with network/model/cache latency. The original raw report's zero baseline latency was an unmeasured placeholder; use `assessment.json` for the separately measured baseline. The runner now represents unmeasured baseline time as null.

Per-language binary results (`TP/FP/TN/FN`; each language has 9 special and 15 non-special cases):

| Method | Language | TP/FP/TN/FN | Precision | Recall | False-special / non-special | Correct / total | Abstention |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Jev | ja | 9/1/14/0 | 90.00% | 100.00% | 1/15 (6.67%) | 22/24 | 16.67% |
| Jev | en | 9/1/14/0 | 90.00% | 100.00% | 1/15 (6.67%) | 22/24 | 16.67% |
| Jev | zh | 9/2/13/0 | 81.82% | 100.00% | 2/15 (13.33%) | 20/24 | 20.83% |
| Jev | ko | 9/2/13/0 | 81.82% | 100.00% | 2/15 (13.33%) | 22/24 | 12.50% |
| Jev | es | 9/1/14/0 | 90.00% | 100.00% | 1/15 (6.67%) | 21/24 | 20.83% |
| Frozen regex | ja | 1/3/12/8 | 25.00% | 11.11% | 3/15 (20.00%) | 10/24 | 0.00% |
| Frozen regex | en | 2/9/6/7 | 18.18% | 22.22% | 9/15 (60.00%) | 6/24 | 0.00% |
| Frozen regex | zh | 1/2/13/8 | 33.33% | 11.11% | 2/15 (13.33%) | 11/24 | 0.00% |
| Frozen regex | ko | 1/0/15/8 | 100.00% | 11.11% | 0/15 (0.00%) | 13/24 | 0.00% |
| Frozen regex | es | 0/0/15/9 | n/a | 0.00% | 0/15 (0.00%) | 12/24 | 0.00% |

Full three-class confusion matrices below use rows gold special/reference/uncertain. Each cell lists predicted `special/reference/uncertain/provider_failure` counts:

| Method | Language | Gold special | Gold reference | Gold uncertain |
| --- | --- | --- | --- | --- |
| Jev | all | 45/0/0/0 | 7/47/6/0 | 0/0/15/0 |
| Jev | ja | 9/0/0/0 | 1/10/1/0 | 0/0/3/0 |
| Jev | en | 9/0/0/0 | 1/10/1/0 | 0/0/3/0 |
| Jev | zh | 9/0/0/0 | 2/8/2/0 | 0/0/3/0 |
| Jev | ko | 9/0/0/0 | 2/10/0/0 | 0/0/3/0 |
| Jev | es | 9/0/0/0 | 1/9/2/0 | 0/0/3/0 |
| Frozen regex | all | 5/40/0/0 | 13/47/0/0 | 1/14/0/0 |
| Frozen regex | ja | 1/8/0/0 | 3/9/0/0 | 0/3/0/0 |
| Frozen regex | en | 2/7/0/0 | 8/4/0/0 | 1/2/0/0 |
| Frozen regex | zh | 1/8/0/0 | 2/10/0/0 | 0/3/0/0 |
| Frozen regex | ko | 1/8/0/0 | 0/12/0/0 | 0/3/0/0 |
| Frozen regex | es | 0/9/0/0 | 0/12/0/0 | 0/3/0/0 |

Provisional gates were precision >=95%, recall >=90%, false-special <=2%, with no sharply failing tested language. Precision and false-special gates fail overall; precision also fails in every tested language. Factual capability-failure records account for five false-special cases, and two runbook cases for the others. Keep production auto-enable off and observe in shadow. Five languages and small per-language samples do not establish arbitrary-language reliability or tight confidence bounds.

## Evidence and verification

The immutable `held-out.json` was measured before the final cache-current-entry fix. Its SHA-256 is `11ba14264c4945d2e6dd15fc254cd81b4ed2bbc53b866c8bd90ea524d92e6c54`. Model-input contract digest remains `fc16c03dae9fac288f713acc0e1e64cdff2bc338600e8cf2b3b873441f63054e`; corpus digest remains `55350662ade98aaeb475829cfc5158828d629da2ac06ae72b93d959afb20c80d`. Prompt, model, policy, threshold and corpus were not changed after held-out evaluation. The old quality result is preserved, not relabeled as final-source evidence. Final-source live timing and main MCP handoff were rerun after the cache fix.

Final targeted checks on this Mac:

- DSH 35/35 selected unit/integration/adapter/contract/migration-assets checks passed; metrics-only follow-up 3/3 passed after clarifying unmeasured baseline time.
- DSH native consumer: 12/12 passed, covering public/adapter, delivered/dropped input and shadow/reference/uncertain/outage safety.
- Kiokuko 54/54 selected cache, MCP wire/consumer/capture and additive-migration checks passed.
- Both repositories' TypeScript noEmit checks passed.
- Both isolated source snapshots built. Compiled DSH + compiled Kiokuko product-pair passed four public/adapter delivery cases using actual Rust 1.99.1; scripted decision fixtures establish handoff/gating, not model accuracy.
- Runtime source files in those snapshots byte-matched final source. `npm pack --ignore-scripts --json` verified compiled common files and new migration assets in both packages. No install/publish occurred.
- Final live MCP handoff: two synthetic captures, two real Jev calls, zero repeat calls; observed special/reference both delivered as uncertain/shadow; unobserved/unverified/no authorization retained.

Tests cover persisted restart reuse; title/body/summary/revision/config invalidation; duplicate capture enrichment; concurrent mutation and retained old objects; deleted/foreign-workspace rows; malformed/timeout/outage/abstain; cancellation; corruption; legacy schema upgrades; reference not activating compatibility gates; strict Laya admission; full/core and main MCP wire consumers. The stale-object regression was observed red before adding the pre-cache current-entry check, then green in both implementations. Only disposable databases were migrated.

This is implemented, locally unit/integration tested, built-artifact tested and live measured. **GitHub CI/Linux is not tested for this uncommitted diff.** No new CI jobs or check weakening was introduced. Rust 1.99.1 local evidence is not Rust 1.85 CI evidence. No commit, push, version change, installed live-plugin change, global configuration change, live database migration or unrelated doctor repair was performed.

Reproduction (isolated Node 24 and existing dependencies; synthetic data only):

```sh
node --import tsx scripts/evaluate-correction-classification.mjs --live --config /path/to/ephemeral-provider.json --split development --output /tmp/development.json
node --import tsx scripts/evaluate-correction-classification.mjs --live --config /path/to/ephemeral-provider.json --split held-out --output /tmp/held-out.json
node --import tsx scripts/evaluate-correction-classification.mjs --live --config /path/to/ephemeral-provider.json --split development --prototype-only --prototype --output /tmp/timing.json
node --import tsx scripts/verify-correction-mcp-live.mts /path/to/kiokuko /path/to/ephemeral-provider.json /tmp/live-mcp.json
```

The host must supply its already-authorized process-local provider credential. The benchmark does not discover new credentials or grant external access. Exact targeted test arguments, build outcomes, final runtime hashes and package evidence are in the accompanying verification JSON. Frozen corpus and runner live in DSH; Kiokuko copies the shared results for cross-product evidence.
