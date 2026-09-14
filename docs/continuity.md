# Continuity projection

Continuity is an opt-in, disposable view of existing execution records. It does
not save model hidden state, train a model, add memory tables, issue model
requests, or advance a run. Deep planning keeps its existing prompts and state.

## Configuration

Set the Kiokuko plugin configuration and reload it through the existing DSH
plugin lifecycle:

```yaml
continuity:
  mode: off                 # off | shadow | active
  maxSupplementBytes: 4096   # integer, 512..8192 UTF-8 bytes
  maxItems: 12               # integer, 1..24
efficiency:
  observe: true              # optional bounded in-memory numeric observations
```

`off` leaves the existing evidence presentation in place and does no continuity
source loading or view construction. `shadow` constructs the proposed display
but sends the same text as `off`. `active` replaces the recent-evidence portion
of `kiokuko:execution`; it preserves the existing frame, constraints, exploration
notice, terminal notice and formal Enno directive. It does not copy memory or
the directive's criteria and next action into another permanent snapshot.

Whole items are selected within the configured byte and item limits; at most
three next-check items can be displayed. The footer always states coverage and
omitted item count. The byte budget applies to the supplement, not the original
request, mandatory conditions or directive. `complete` means that the selected
adapter fields were available, not that the task succeeded or a whole document
was read. The evidence window remains bounded to the existing 32 records; when
that window is full, coverage is conservatively `partial` even if all displayed
items fit. Its footer cannot count unknown records outside the loaded window.

## Ownership and delivery

The host resolves the native session/run binding, updates intake and the
execution frame, and supplies committed evidence. The adapter and renderer are
deterministic functions with no I/O. Source digests include the owner, frame
content and generation; Enno additionally includes contract/mutation revision,
route, directive and next action. A separate body digest describes display
content. Neither digest is proof of correctness or authorization.

The normal adapter ranks incomplete acquisition/presentation first, exact
explicit read targets second, and recent observations next. All acquisition
records are historical. A previous `presentation: full` is never asserted to be
full in the current request. The final stream seam observes actual native tool
results; the short supplement itself is not a full presentation of that result.

The Enno adapter accepts only the bound run, native session, workspace, contract,
route, role and current WorkUnit. It includes reports for that WorkUnit and its
declared dependencies, explicitly labeled `model-report / unknown`. It does not
promote `outcome: completed` into test success. Final verifier records remain
`unknown` with respect to current repository freshness. The existing Enno service
still owns the freshness and authorization checks. Raw verifier output is not
copied into the supplement.

The current integration needs one additional existing-service Enno snapshot read
per nonterminal, unpaused model request in `shadow` or `active`. It uses the
service's existing repository/verification checks; it does not run verifiers.
This cost is not claimed as an optimization. Normal execution adds no DB read.
Source mismatch or optional rendering failure degrades the supplement without
changing the existing directive, tool outcome or authorization checks.

Both native snapshot projection paths use retained surface events. An old
snapshot remaining only in append-only history cannot suppress re-delivery or
revive another plugin's compacted section. The current assembly's other sections
are preserved. Without a direct surface API, the existing append/replace replay
helper reconstructs retained events; invalid history cannot establish delivery.
An uncommitted projection attempt is never evidence of delivery. No extra
delivery cache or native session-event type is introduced.

`efficiency.observe` exposes bounded `snapshot().continuity` entries containing
only mode, bytes, item/omission counts, coverage and copies found in the final
request. No source text, paths, credentials or source digest is recorded there.
Observer errors leave `next()` and the original stream outcome unchanged.

## Disable and recover

Set `continuity.mode: off` and reload the plugin. The next request rebuilds the
existing execution section, replacing the active supplement. The original
conversation, conditions, evidence and Enno state remain. Resume uses the
existing run/session route and lease rules; it neither replays tools nor moves
state to a different run. No schema migration or rollback migration is needed.
No unsupported new cross-session resume capability is added.

## Verification and measurements

The baseline is commit `4094b061c6f713c6cde550b4b4cebe4bd8d715dd` (`0.1.49`).
The starting local `0.1.14` checkout lacked the required modules; it was updated
to the plan's baseline before implementation. The lockfile hashes and one
scripted native lifecycle per mode are recorded in
[`baseline.json`](../tests/fixtures/continuity/baseline.json).

Before the repair, the compaction counterexample returned zero snapshots where
one current snapshot was required. The existing focused baseline had 16 passing
tests. The added tests inspect the real DSH `0.1.5-rc.1` final model request after
native surface replacement and same-run plugin reload, plus observer failures,
late refreshes, mode changes, hostile text, source ownership, byte limits,
dependency reports and verifier labels.

All three native runs made 10 scripted model requests and five reads. The
`shadow` request byte array matched `off` exactly. `active` increased bytes;
this is not evidence of improved reasoning, speed or token efficiency. Mock
usage is not real model usage. SQL counts, DB timings, expansion counts and
provider tokens were not measured and remain `null`. PR-4 retrieval caching is
therefore not implemented. No adoption or default-enable conclusion is drawn.

```sh
npm run typecheck
npm run test:continuity
# Include the real native-loop cases; missing runtime then fails instead of skipping.
KIOKUKO_DSH_PACKAGE_ROOT=/path/to/pinned-dsh/node_modules \
KIOKUKO_REQUIRE_DSH_NATIVE=1 npm run test:continuity
```

The runtime fixture is `tests/fixtures/dsh-runtime/package-lock.json`, as in CI.
Verification used Node `v26.7.0`, npm `11.19.0` and DSH `0.1.5-rc.1` on macOS.
Packaged install, Web bundle load, reload and uninstall were exercised with
the existing CLI lifecycle checks in an isolated profile and home directory.

Verification on 2026-09-14:

| Check | Result |
| --- | --- |
| Typecheck, build, publint, pack closure/import checks | Passed |
| Full suite with required pinned native runtime | 688 passed; one CLI-path-dependent test initially skipped |
| Initially skipped bundle-install test with explicit `DSH_BIN` | Passed, no skip |
| Final continuity suite (including real native requests) | 23 passed, no skips |
| Real Enno native resume/verification/completion with active continuity | Passed |
| Sample database initialization and resume | Passed |
| Evolution regression suite | 33 passed |
| Efficiency and Akinator synthetic evaluations | Completed; not model capability evidence |
| Packaged CLI install/Web/reload/uninstall | Passed using the existing lifecycle portion separately from native tests |
| Configured evaluation runner | Mock-fetch budget, privacy and output-reuse tests passed; no real provider used |

Contracts were reviewed with `code.boundary.v1`, `code.protocol.v1` and
`code.verification.v1`; the evaluation I/O also used `code.effects.v1`.
The flow checked was config → native host → committed sources → execution
snapshot → final request → numeric observation, including packaged activation
and reload. No retrieved memory claims were supplied for this implementation.

## Explicit model evaluation

```sh
npm run test:evaluation:continuity
# No configuration: unmeasured; no network or model calls.
npm run test:evaluation:continuity -- \
  --config continuity-evaluation.local.json --output continuity-evaluation-results
```

Run these commands from a source checkout. The runner evaluates six fixed **context recovery probes**, not full repository
tasks or a new autonomous loop. The fixture digest and exact JSON grading rules
are fixed in `tests/fixtures/continuity/manifest.json` and `scenarios.json`.
Each trial gets a disposable workspace, fixed input, model/settings and budget;
it never opens the user's DB or sessions. A/B order is randomized by seed.
Pairing and bootstrap intervals use scenarios, not individual turns. Small
sample intervals do not establish the plan's end-to-end adoption criteria.
The plan's larger, real-agent pilot remains a separate evaluation.

Example configuration for a compatible chat-completions endpoint:

```json
{
  "fixture": "continuity-v1",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "your-model",
  "revision": "your-pinned-revision",
  "temperature": 0,
  "contextWindow": 32768,
  "maxOutputTokens": 256,
  "repetitions": 2,
  "seed": 42,
  "maxRequests": 24,
  "maxTokens": 792576,
  "maxDurationMs": 600000,
  "allowRemote": false
}
```

An optional `apiKeyEnv` names an environment variable; never put credentials in
the file or URL. Optional `reasoningEffort` is sent explicitly. Remote endpoints
require `allowRemote: true`; redirects are rejected. Each call reserves the
declared context window plus maximum output against the total token budget.
Reservations are conservative limits, not reported usage. Missing usage stays
`null`; no retry is issued for uncertain failures. Cache state is uncontrolled
and the declared immutable model revision is not independently verified.
Existing reports are rejected before making calls. Reports contain bounded
measurements and scores, not prompts, response text or authentication data.

Real-model results are currently **unmeasured**. `off` remains the default.
