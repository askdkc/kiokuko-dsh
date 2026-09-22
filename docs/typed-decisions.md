# Typed AI decisions

Kiokuko uses one host-owned decision service for provisional Akinator task types,
installed Skill relevance, past memory reuse, Zenki draft review, optional [post-display answer review](answer-review.md), and semantic decisions inside Lisp.
The selected adapter owns its transport protocol and uncertainty policy. Domain
workflows consume `selected` or `abstained`; they do not depend on model names.

Switch backends in DSH without a restart:

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Switching verifies a synthetic known answer before committing the choice. Laya
uses the existing `start-laya` worker at the configured or default socket;
no replacement worker or manual fingerprint is required. Failed/cancelled verification and
failed persistence leave the active choice unchanged. Jev requires a key, and
Nimble requires its endpoint and model first. Selection is stored in Kiokuko's
SQLite database for the repository and base `typedDecisions` configuration, survives
restarts, and applies only to new logical requests. `use default` restores the
base configuration. A stale host cannot overwrite a selection saved by another
host; restart it to load the latest choice. Changing the base configuration uses
that configuration's selection, with the YAML provider as the default.

Configure `typedDecisions` on the full plugin or modular core:

```yaml
typedDecisions:
  mode: auto
  provider: typesafe
  typesafe:
    model: jev-latest
    timeoutMs: 5000
    acceptance:
      minConfidence: 0.8
```

Set the TypeSafe key through DSH, then inspect status:

```text
/kioku-typesafe-key <key>
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

Key input is visible while typing. Status makes no inference call and never shows
credentials. `probe` sends a fixed synthetic question with a known answer; it
creates no decision history. Configuration readiness is separate from working
authentication. Status includes the last probe time, reason and whether automatic
[memory reuse](memory-reuse.md) is currently available. Status resolves local
credential availability but makes no inference call.

For Nimble, supply the complete endpoint and model explicitly:

```yaml
typedDecisions:
  mode: auto
  provider: nimble
  nimble:
    endpoint: http://127.0.0.1:8000/v1/systemone
    model: your-served-model
    timeoutMs: 5000
    # Optional: a credential reference resolved by DSH's credentials service.
    # credentialRef: NIMBLE_API_KEY
    acceptance:
      minProbability: 0.9
      minMargin: 0.2
```

HTTPS and loopback HTTP are allowed. Embedded credentials, query/fragment,
non-HTTP schemes and redirects are rejected. Nimble never receives the TypeSafe
credential. Kiokuko does not install models, start a Python server, train models,
or manage GPUs. There is no default public demonstration endpoint.

Nimble supports at most 64 questions and 26 choices per question, including
abstention. Its documented per-branch prompt limit is 2,048 tokens; server
admission remains authoritative. Bytes are not tokens. Questions may be batched
only with their complete evidence and alternatives; a plan is never truncated.
No metadata endpoint is required for evaluation. See the
[Nimble serving contract](https://github.com/bespokelabsai/nimble/blob/main/docs/MODAL_SERVING.md).

For local Laya-CoreML, run `/kioku-decisions use laya` after `start-laya`.
The host connects directly to `~/Library/Caches/laya-coreml/worker.sock` using
v1 `health`/`predict`; no HTTP bridge, subprocess client or replacement worker
is needed. `/kioku-decisions install-laya` reuses an existing worker, or shows
startup/setup instructions if it cannot connect. It does not install Python or models.
Only configure `socketPath` if your socket differs from the default.

A plain v1 worker has no runtime fingerprint or input-completeness preflight;
status reports `protocol: "v1"` and `runtimeFingerprint: null`. The host preserves
all request text, validates responses and pins the socket configuration, but cannot
verify internal token truncation or model identity. Existing strict workers retain
`preflight`/`predict_strict` support and explicit fingerprint pins are never relaxed.
See [Laya configuration](laya-coreml.md). The optional Laya section and new fields
preserve old TypeSafe/Nimble and strict Laya stored configuration digests.

The initial acceptance policies are provisional routing heuristics, not accuracy
estimates. TypeSafe uses choice confidence; Nimble uses the selected probability
and margin, not its entropy-derived confidence. Laya also uses probability/margin, with its own conservative four-decimal rounding policy. Ties, explicit abstention and
failed thresholds become `abstained`. Model/revision/usage metadata is recorded
only when supplied. English and Japanese quality and latency must be evaluated
separately for each configured model; mocked tests establish protocol behavior.

Each logical request snapshots configuration. Completed results persist under a
digest of evidence, ordered questions and choices, Skill catalog, configuration
and policy version. New configuration applies to new requests. Automatic calls
have a five-second default budget bounded by parent cancellation. There are no
HTTP retries or automatic changes to another decision provider. `mode: off`,
missing configuration, uncertainty and service failures use the existing workflow
fallback. Identity, revision, permission and integrity failures never authorize
fallback execution.

Zenki calls `enno_plan_review` with the complete candidate. All atomic checks must
be answered; otherwise the exact persisted `roles.check` model reviews the full
candidate in a no-tool stream. Both paths share a 30-second review budget. All
three contribution slots need dispositions. `enno_plan_submit` accepts only the
identical reviewed candidate with the same catalog and revisions. A changed draft
requires review again. If neither reviewer completes, the draft remains
unsubmitted. Existing confirmation and Goki lease checks still apply. Already
accepted plans continue normally; old pre-draft advice cannot satisfy review.

In Lisp:

```lisp
(kioku.decisions:status)
(kioku.decisions:assess-relevance
  "Fix the import failure"
  (vector (kioku.data:parse-json
    "{\"id\":\"module\",\"description\":\"The failing module import\"}")))
```

`evaluate` takes evidence and an ordered vector of questions, each with `id`,
`instructions`, ordered `choices` (`id`/`description`) and `abstainId`.
`assess-relevance`, `classify-failure` and `assess-change` construct those questions.
A response has `status: completed` with `result.answers`, or `status: fallback`
with a bounded reason. Consume answers before deciding what to inspect. These
helpers perform no file/process/proposal effects. Ordinary failure or abstention
returns control to inspection/reasoning; cancellation stops evaluation. Mode
selection, worker identity/generation checks and proposal approval remain intact.

The explicit `kioku.typesafe:status` / `evaluate` API, including `noul` and `score`,
and `/kioku-typesafe-key` remain TypeSafe-specific compatibility interfaces.

[Semantic compaction](semantic-compaction.md) shares this service for automatic history shortening, including readiness, credentials, acceptance policy, persisted decisions and bounded concurrency. Its independent setting is `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }`.

## Post-display answer review

Set `answerReview: { mode: auto, budgetMs: 5000 }` on the full plugin or modular core (default: off).
The original answer is streamed first. Three finite rubrics check request fit, contradiction with current-run tool results, and exaggerated verification claims. Accepted findings can trigger one reconsideration by the same main model. The selected `typedDecisions` provider, acceptance thresholds and request binding are reused; there is no provider substitution or LangChain dependency.

Evaluation failure, abstention or capacity rejection preserves the original answer. Laya v1 output is an unverified suggestion because internal truncation cannot be detected; strict workers preflight every complete part. The main model must inspect the original evidence before accepting a concern. Evaluation adds inference; reconsideration adds at most one main-model turn. [Lifecycle, limits and measurement commands](answer-review.md).
