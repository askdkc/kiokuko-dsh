# Skill prompt compiler

The compiler extracts author-classified runtime guidance from the canonical
`skills/` tree. It makes no model calls. The default remains **full** until live
quality comparison, Japanese review and native/package delivery gates pass.

```yaml
skillPrompts:
  mode: compiled # full (default) | compiled
```

Reload the plugin to change modes. `full` is also the rollback setting. Neither
mode changes native permissions, tool schemas, task selection or the original
user message. The ordinary Skill catalog is not a claim that every listed Skill
was loaded. SOUL is automatic; Japanese guidance follows the routed model family;
Lisp guidance follows explicit enable; Enno contracts follow the current role and
selected experts; ordinary additional Skills remain available through the native
Skill tool. Complete supplied runtime guidance needs no full-file reread.

## One source, two representations

The original files remain the canonical source and continue to be deployed to
the existing managed Skill directories. Nine main Skills are annotated. The 15
unannotated reference files remain verbatim. Each annotated file classifies all
body text (apart from its frontmatter and management marker):

```markdown
<!-- kiokuko:runtime rule-id -->
Required behavior, exceptions, failure actions and necessary API examples.
<!-- /kiokuko:runtime -->
<!-- kiokuko:documentation example-id -->
Optional explanation that adds no new requirements.
<!-- /kiokuko:documentation -->
```

IDs are unique within each resource. Nested, duplicate, empty-runtime, unclosed
or malformed blocks, and unclassified prose fail the build. Markers within fenced
examples are literal. The compiler copies runtime blocks in order; it does not
infer requirements from MUST/NEVER, summarize prose, or truncate rules. Changes
to normative wording require review against the fixed pre-change baseline in
`tests/fixtures/skill-prompts/baseline.json`. Hashes prove correspondence and
staleness, not semantic equivalence.

The normal build/prepare emits `dist/dsh/skill-prompts.json` with compiler version,
source and content hashes, selected block IDs and byte counts. Output contains no
timestamps, local paths or random values. The package includes both source and
generated artifact. A plugin-lifetime `DshSkillPrompts` instance validates and
caches these inputs; reload creates a fresh instance. Missing/stale/corrupt
artifacts return validated full source with a fallback diagnostic; invalid
original source still fails its existing integrity checks. Runtime never calls
the compiler. `host.skillPrompts.diagnostics()` records resolved representation
and fallback, not proof of model delivery, and contains no prompt text.

Explicit runtime hosts must accept the shared instance through
`configureSkillPrompts`; unsupported compiled configuration fails visibly.
Prompt-only hosts use the same source/provider loader. Public source loaders
continue to return original files for deployment and inspection.

## Delivery evidence

`npm run test:skill-delivery` runs the actual plugin entrypoint against the pinned
DSH runtime, then packs and extracts the npm artifact and repeats the checks.
It requires installed fixture dependencies and protected SBCL (plus Bubblewrap
on Linux). Missing prerequisites are failures, not successful skipped coverage.
Its opt-in cases live in `tests/dsh/skill-delivery/`, outside the mandatory native
E2E directory. The separate native lifecycle runner still rejects every skipped
test; placing opt-in cases in that directory would break that gate.
The test uses an isolated Skill home, state directory and temporary Lisp worker;
it never installs into the user's live profile.

| Consumer | Evidence boundary |
| --- | --- |
| SOUL, native/explicit/prompt-only entrypoints | Compiled body in adapter-observed request |
| All nine native Skill lookups | Native tool execution, result rendering, next request |
| Enno role Skills and selected expert | Real admitted role transitions, retry and persisted resume |
| Deep Japanese guidance | Every worker's request and budget accounting |
| Lisp enable and lisp_describe | Real protected SBCL, six-tool surface, next request body |
| DeepSeek wire serializer | Actual provider serializer; fetch boundary captured before network |
| Disconnected SOUL injection | Artifact still exists; the same body assertion fails |
| Disconnected Skill reader | Native lookup lacks its body while automatic SOUL still arrives |

Native response scripts establish delivery, not live model quality. The HTTP
test replaces only the transport response; it does not hand-build a replacement
provider payload. Headless tests stub unused Web transport registration and
answer the real intake question. They do not bypass the compiler or injection.

Retained host-owned single-Skill snapshots update through DSH's append-only
surface replacement. The log stays intact. Compaction and reload restore current
guidance, not an obsolete "already loaded" flag. A confirmed current system
section prevents duplicate routed guidance; user messages, other plugins and
tool results are not rewritten.

## Size and quality gates

`npm run test:skill-efficiency` compares fixed representative envelopes with the
pre-change source baseline. Its gates are aggregate Skill-byte reduction >=30%
and no envelope growth in any case. These are serialized fixture sizes, not
provider token counts or billed savings. Native payload delivery is measured
separately. `npm run test:skill-quality` without configuration reports unmeasured
and makes zero model calls.

For live isolated behavior probes, supply `-- --config evaluation.json --output
new-output-directory`. Configuration requires a fixed `model` and `revision`,
an OpenAI-compatible `baseURL`, the name of an `apiKeyEnv` variable (never a key
in the file), `allowRemote`, `maxRequests`, `maxTokens`, `maxDurationMs`,
`contextWindow`, `maxOutputTokens`, and `temperature`. There are 13 fixed cases,
two representations and three repetitions (78 requests for a complete run).
Each request reserves contextWindow + maxOutputTokens against the hard local
reservation budget. Failed requests count and are never automatically retried.
The model returned by the endpoint must match the configured identity.

Results include response hashes, available usage, machine checks and a shuffled
Japanese review file. Assess naturalness 1–5 plus meaning, modality, identifier
and schema violations without looking at representation labels. Default
promotion requires all planned requests completed, zero required violations,
compiled machine successes >= full, Japanese scores >= full with no meaning
loss, and native/packed delivery passing. No byte counter or file hash can pass
the Japanese-quality gate. The runner never changes configuration automatically.

Current status: implementation and local delivery can be tested independently;
live model quality and cost are unmeasured. Keep `full` as the default.

## Verification recorded on 2026-09-17

- Node 26.7.0, the repository's pinned DSH fixture packages, macOS and SBCL 2.6.8.
- Dedicated delivery: **20 passed, 0 failed, 0 skipped** across source and extracted
  npm tarball (10 cases each). This includes both disconnected-reader/injection
  controls, the real protected Lisp worker and the provider's HTTP serializer.
- Compiler and snapshot tests: 7 passed, covering malformed classification,
  exact code whitespace/CRLF, fallback diagnostics, ownership and restoration.
- The broader suite recorded 678 passes, no failures and 106 conditional skips;
  its environment-dependent skips are not counted as delivery evidence. The
  mandatory delivery job above runs separately to avoid the broader suite's
  build/pack test replacing artifacts while they are being verified.
- Typecheck, build, package import/closure checks, publint and whitespace checks
  passed. Recompiling all 24 canonical resources in a fresh process reproduced
  the published-format Skill artifact byte-for-byte.
- Fixed representative Skill bytes decreased **32.1% in aggregate**, with no
  envelope growth in any case. These are fixture byte measurements, not token
  or price measurements. Live model/Japanese quality remains **unmeasured**;
  compiled mode has not been promoted to the default.
