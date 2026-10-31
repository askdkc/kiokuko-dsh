# Typed AI decisions

Kiokuko uses one host-owned decision service for provisional Akinator task types,
installed Skill relevance, past memory reuse, Zenki draft review, [post-display answer review](answer-review.md), and semantic decisions inside Lisp.
The selected adapter owns its transport protocol and uncertainty policy. Domain
workflows consume `selected` or `abstained`; they do not depend on model names.

Task classification treats ordinary questions and advice as `chat`; an explicit
source lookup is `research`. Laya receives complete current requests up to 4096
UTF-8 bytes, including queued coding requests, multiple sentences, quoted filenames,
source material, combined actions and negations. All eight task types and `abstain`
are offered; the selected model chooses the primary intent, never a punctuation or
keyword default. An accepted result avoids the redundant purpose question.
Prior-turn confirmations without context and explicitly undecided alternatives
retain the existing intake path. The envelope limit is not a token-budget claim:
provider capacity, confidence, margin and reported-truncation checks remain unchanged.
Abstention, unavailability or capacity rejection still defer inference. Native full
and core adapters let the ordinary model reason about that original request and
supply advisory intent through `prepare_requested_work`, rather than repeat the
category dialog. No tool effects are granted by this fallback. Requests are never
excerpted or rewritten, and classification grants no execution permission.

The common API also accepts explicit `noul` (yes probability) and `score`
(ordered rubric) questions. Their validated answers have `status: "measured"`;
they grant no permission. The existing Choice request and answer shapes remain
valid. TypeSafe and OpenAI can evaluate all three question types in one batch. Nimble and
Laya accept Choice only and return `DECISION_UNSUPPORTED` before inference for
other kinds. The separate Lisp `kioku.typesafe:evaluate` API retains its own
wire contract.

Switch backends in DSH without a restart:

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use openai
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

<a id="openai-credentials"></a>
## OpenAI credentials

Jev remains the default; OpenAI, local Laya and Nimble are alternatives. OpenAI uses the official [Decisions API](https://developers.openai.com/api/docs/guides/decisions), `POST /v1/decisions`, with `gpt-6-luna` as this checkout's default decision model. This is separate from the main chat model: ChatGPT/Codex OAuth login does not supply `OPENAI_API_KEY`, and a TypeSafe/Jev key cannot replace it.

These instructions describe the current source. They do not assert that the published npm `latest` already includes OpenAI support. If `use openai` is unavailable, check the installed build's command support first.

1. Create an API key for your OpenAI API project and add it to the credential store used by the running DSH. With the standard `credentials-local` provider, choose the path as follows:

   | Configuration | Credential file |
   |---|---|
   | Default harness home | `~/.dsh/.credentials.yaml` |
   | Custom `DSH_HOME` | `$DSH_HOME/.credentials.yaml` |
   | Explicit `credentials.path` (the provider's `config.path`) | The configured path, overriding the home default |

   `--profile web` keeps profile packages and patches under `$DSH_HOME/profiles/web`; it does **not** by itself move credentials there. A profile can override `credentials.path`, or its launcher can use another `DSH_HOME`. Use that effective file, not a guessed `profiles/web/.credentials.yaml`.

2. In an existing file, add only `OPENAI_API_KEY` under `refs` and preserve all other `refs` and `records`. This is a minimal **new-file example**, with a nonfunctional placeholder:

   ```yaml
   version: 1
   refs:
     OPENAI_API_KEY: "OPENAI_API_KEY_EXAMPLE_ONLY"
   records: {}
   ```

   Replace the placeholder privately with your key. On macOS/Linux, protect the actual file; for the default path:

   ```sh
   chmod 600 "$HOME/.dsh/.credentials.yaml"
   ```

   Use your configured path instead when it differs. The default `watch: true` reloads valid file edits automatically for subsequent requests; restarting DSH is unnecessary. Do not paste keys into chat, screenshots or Git.

3. In DSH's command input, select OpenAI and inspect the result:

   ```text
   /kioku-decisions use openai
   /kioku-decisions status
   ```

   `use openai` makes a real API probe, which may incur usage charges. Only a successful probe and save persist the choice for this project and new requests; failure or cancellation keeps the prior choice. Existing requests keep their binding. `status` makes no inference call. Optional `/kioku-decisions probe` makes another real probe.

The standard provider resolves **saved file > launch environment > project `.env` > harness-home `.env`**. Environment variables still work when the credentials service is present, unless a saved value overrides them. For an environment-only setup, export the key **before** launching DSH from that shell:

```sh
export OPENAI_API_KEY='OPENAI_API_KEY_EXAMPLE_ONLY'
```

This is a placeholder, not a usable key. An export in another shell after DSH has started does not update its launch snapshot; use the watched file to update an already running instance. Keep credential-bearing `.env` files out of Git.

## Provider configuration

Configure `typedDecisions` on the full plugin or modular core:

OpenAI uses the distinct official [Decisions API](https://developers.openai.com/api/docs/guides/decisions),
`POST https://api.openai.com/v1/decisions`, rather than Responses JSON output.
It maps Choice, Noul (predicate) and Score to the native API and validates ordered
named answers, distributions, rubric levels and individual refusals. The default
model is `gpt-6-luna`; probability ≥ 0.9 and margin ≥ 0.2 are required for Choice.
Kiokuko resolves `OPENAI_API_KEY` through `ctx.credentials.resolve` when the service
exists; the standard local provider includes the launch environment and `.env`
fallbacks described [above](#openai-credentials). Only a composition without that
service uses Kiokuko's direct `process.env` fallback. A different credential
provider may have different resolution rules. TypeSafe credentials are never substituted. No redirects,
automatic retries, or provider fallback are added. `use openai` probes before
persisting; missing credentials, failed probes and cancellation leave selection unchanged.
Existing Jev/Laya stored configuration digests retain their original shape.
Current token records retain input/output totals; cached-token breakdown is not recorded.

To select OpenAI in the plugin or core configuration instead of a project command:

```yaml
typedDecisions:
  mode: auto
  provider: openai
  openai:
    model: gpt-6-luna
    timeoutMs: 5000
```

Keep keys in the credential store, not in `typedDecisions`. A configured provider
is not evidence of a successful API call; use the command probe to verify access.

The normal startup card offers the four decision/Lisp ON/OFF combinations and Cancel
in one question before model tool assembly. It uses the currently selected backend,
shown in the card; selection does not prove authentication or successful inference.
Immutable existing decision bindings also retain the task choice, without granting
tool or file authority. The same request and explicit continuation reuse the choice;
an unrelated new request asks again. Cancel/Skip starts no task. Headless operation
keeps the configured decision mode and explicit manual Lisp preference; an explicit
`typedDecisions.startup: { decision: true, lisp: true }` config selects both.
Runtime failures retain the choice and permit explicit recovery without a new question.

Semantic-comparison diagnostics retain only the known criterion names
(`action`, `reference`, `constraints`, `latest-answer`) and finite verdicts, with
backend, elapsed time, gate outcome and existing request/decision correlation.
They contain no source text, credentials or private reasoning. `providerDispatched`
means the provider adapter was invoked; it does not prove a successful HTTP exchange.
These diagnostic fields never change acceptance or native permissions.

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

Optional Skill Score selection requires an explicit policy. For example, the
following thresholds are configuration inputs, **not validated defaults**:

```yaml
typedDecisions:
  provider: typesafe
  skillSelection:
    mode: score
    minScore: 2
    minConfidence: 0.8
```

With no `skillSelection` section, installed optional Skills retain the current
Choice selection. Score uses four ordered levels: not applicable, related but
not materially useful, materially applicable, and directly applicable. The host
keeps mandatory Skills, excludes uninstalled Skills, and adds at most five
optional Skills. Low confidence falls back to the existing catalog-similarity
baseline; a high-confidence Score below `minScore` excludes the candidate.
Provider failure falls back for the whole batch without a second inference or
provider switch. Score mode with Nimble or Laya therefore uses the baseline.
The policy and rubric are bound to the logical request and its result digest.

Memory reuse accepts an explicit `typedDecisions.memorySelection` policy: `choice`, or `noul` with a policy version and separate accept/reject probabilities. Noul evaluates usefulness, constraint compatibility, and prerequisites. Choice remains the default pending live quality evaluation. Existing request bindings without this field remain Choice. Nimble and Laya reject explicit Noul before inference. See [memory reuse](memory-reuse.md).

`/kioku-decisions status` includes up to 128 in-memory decision observations:
question-kind counts, provider/model identity, policy version, cache hits,
fallback reason, elapsed time, logical batch JSON bytes, and token usage when
available. Memory reuse also records candidate-level applicable, excluded,
uncertain, and unassessed counts. Observations do not store question, Skill,
state, memory, tool-result or
credential text. From a source checkout, run
`npm run test:evaluation:decisions` for synthetic paired Japanese/English Skill
fixtures. The source-only evaluation script and fixtures are not packaged.
A live comparison requires explicit
`--live --model VERSIONED_MODEL --min-score N --min-confidence N` arguments and
`TYPESAFE_API_KEY`; it sends only the checked-in synthetic fixture and must not
be interpreted as a production accuracy estimate.

The following commands manage only the TypeSafe/Jev key; for OpenAI, use the
[credential-file setup](#openai-credentials). Set the TypeSafe key through DSH, then inspect status:

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

Answer review defaults to `answerReview: { mode: auto, budgetMs: 5000 }` on the full plugin and modular core; no opt-in setting is needed. Set `answerReview: { mode: off }` to disable it.
The original answer is streamed first. Three finite rubrics check request fit, contradiction with current-run tool results, and exaggerated verification claims. Accepted findings can trigger one reconsideration by the same main model. The selected `typedDecisions` provider, acceptance thresholds and request binding are reused; there is no provider substitution or LangChain dependency.

An unavailable provider, evaluation failure, abstention or capacity rejection preserves the original answer. Laya v1 output is an unverified suggestion because internal truncation cannot be detected; strict workers preflight every complete part. The main model must inspect the original evidence before accepting a concern. Evaluation adds inference; reconsideration adds at most one main-model turn. [Lifecycle, limits and measurement commands](answer-review.md).
