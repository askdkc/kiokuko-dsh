# Curator semantic classification (opt-in)

Curator no longer treats Japanese/English keywords or character count as semantic
proof. The provider-neutral `curator-classification` Typed Decisions contract asks
three independent questions: reusable meaning, actionable procedure, and
project-bound meaning. It is not correction classification and does not assign
trust, verification, skill readiness, or permission.

## Safe rollout

The feature defaults to off. Explicitly set
`typedDecisions.curatorClassification.mode` to `auto` in the existing Typed
Decisions configuration when intentionally testing or enabling the classifier.
The host passes the configured DecisionService to `curator_check`; it never
substitutes a provider or lowers its acceptance gates. Default-off means Curator
returns no admitted candidates until classification is enabled, with an explicit
`classificationStatus` explaining withheld candidates. Ordinary memory capture,
retrieval, and existing trusted global entries are not disabled.

Current evidence is offline only. Do not interpret the new contract as a claim of
multilingual model accuracy. Validate the selected provider/model against the
benchmark, especially missed project-local boundaries, before enabling it for
real data. Enabling may send complete title, summary and body to the configured
provider, subject to the existing credential, secret filtering and size limits.

## Persistence and approval

Inference is not guaranteed deterministic. A successful classification is stored
with source identity/revision/content digest, schema/policy version, configuration
digest, provider/model metadata, and result digest. The first persisted result
wins for that exact identity. Repeated views and restarts replay it; downstream
scoring and draft rendering are deterministic. This is integrity/reproducibility,
not evidence that the model is correct. The existing deterministic draft version
continues to describe only draft generation, not inference.

Unknown, abstained, malformed, oversized, timed-out, stale or unavailable results
cannot admit candidates or authorize globalization. No semantic regex fallback
exists. Unsuccessful assessments are not cached by the Curator store (the
DecisionService may retain its own request-bound outcome). A later bounded
invocation can attempt classification again. A view processes at most 50 new
assessments with a 10-second inference budget and reports deferred rows; narrow
filters if necessary. Cached rows are still checked for cancellation and current
configuration.

Globalization remains an explicit application action, never a classifier side
effect. Its synchronous API requires the reviewed assessment digest and a
separate host-owned current configuration digest. Callers must obtain that digest
from the initialized current DecisionService, not from model or user input.
Changed source/configuration, corrupted evidence or missing review identity
reject the action. Project-bound assessments are previewable but cannot be
globalized: revise the source into genuinely portable knowledge, then reclassify
and review it. Lexical draft normalization is not multilingual portability proof.
Existing trust/projection checks and qualified-application evidence stay intact;
classification does not enable the separate automatic globalization route.

## Reproducible evaluation

Run `node --import tsx --test tests/dsh/unit/curator-classification.test.ts` for
SQLite, restart, score-threshold, failure, approval and trust-boundary tests.

Run `node --import tsx scripts/evaluate-curator.ts --oracle` for offline plumbing.
Its 20 cases cover Japanese, English, Chinese, Korean and Spanish with reusable,
local-only, negated and quoted meanings. The oracle supplies expected labels:
20/20 is therefore not a model accuracy measurement.

Run `node --import tsx scripts/evaluate-curator.ts --live config.json` only with
an explicitly enabled standalone Typed Decisions configuration and a configured
provider. It supports TypeSafe, Nimble and Laya through their existing adapters.
TypeSafe reads TYPESAFE_API_KEY; Nimble reads only its configured credentialRef.
The harness does not create, save or print credentials and never globalizes.
Review all unavailable/abstained attempts, not only classified samples. It does
not retry failed samples to compute admission. Per-case elapsed time includes
classification and, on success, cached candidate projection/DB reads. Token and
cost fields are explicitly unavailable, not zero. The fixtures are a small
handwritten set, not statistical or deployment qualification; use further
paraphrases, adversarial text and repeated independent runs for that purpose.
