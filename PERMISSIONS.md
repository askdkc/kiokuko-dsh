# Kiokuko DSH permissions

Kiokuko DSH is a local-first DeepSeek Harness suite. The DSH host owns profile
lifecycle and the plugin only uses the effects required by the selected
Kiokuko operation.

This document describes the full compatibility package. The
[configured core](docs/core-modules.md) synchronizes only its selected managed
Skills and uses the shared database, intake, ledger and scoped memory. It mounts
source-backed index reasoning by default. AgenticReplay, Deep, other advanced-memory workers,
session-history repair and the full browser client are optional. Enno retains the existing compatibility host adapter;
Lisp adds composable tools in the normal development environment; explicit protected mode retains its legacy approval boundaries.
Omitted managed Skills are preserved on disk. Configured startup rejects unsafe
Skill collisions before mounting its runtime; it does not rewrite `AGENTS.md`.

## Local data

- Reads configured Kiokuko SQLite state, registered project roots, and
  repository metadata.
- When a user opens Diff review, reads only the selected native session's
  workspace identity and bounded repository status/diffs. Untracked file
  content is read only after explicit selection. Review results remain in
  process memory until expiry unless the user downloads them.
- Writes the configured Kiokuko database and pre-migration backups, including
  DSH leases, receipts, retrieval state, and embedding state.
- Stores the first native input batch of each governed turn in that database
  for recovery before model or tool execution. This is an input-message copy,
  not a backup of the workspace or whole session. Later step inputs do not
  replace it. Storage failure cannot veto the native turn; observed model or
  tool execution prevents automatic input replay.
- On enabled plugin load, synchronizes all seventeen bundled Skills and their
  references to `~/.agents/skills/` before registering the DSH surfaces. Creates
  missing files and atomically replaces files carrying their exact Kiokuko
  management marker. Leaves unrelated files untouched and refuses unmanaged
  collisions, symbolic links, and unsafe parent directories. A synchronization
  failure warns that deployed copies may be stale; the bundled DSH provider
  remains available. Interrupted synchronization resumes on the next load.
- On enabled plugin load, replaces only the existing Kiokuko managed block in
  the startup directory’s `AGENTS.md` with the DSH host-owned contract. Preserves
  instructions outside the markers; absent or unmanaged files stay untouched.
  Refuses linked files or ambiguous markers. The bundled `scripts/setup-dsh.mjs`
  provides the same repair for an explicit workspace and a read-only `--check`.
  It does not scan parent/global instruction files or other session workspaces.
- On plugin load, enumerates stored DSH session IDs and validates each history.
  When DSH rejects a v3 history containing legacy Kiokuko informational
  events, reads that exact native session file and marks the five supported
  types ignorable under DSH's write lease. Retains a byte-for-byte `.bak`, validates
  in a disposable local directory, and replaces the source atomically. It
  reports failed IDs without exposing message contents; invalid or unrelated
  records remain errors. The same check applies when a chat is opened later.
- For v0 histories, normalizes Kiokuko continuation sources and diagnostic
  stack fields in supported abort causes, validates the native migration in
  isolation, and publishes a new v3 generation under the same native lease.
  Retains the original v0 file and an identical `.bak`; never overwrites an
  existing successor or reconstructs missing turn-ending events.
- After startup validation, automatically deletes a native history file only
  when the compatibility check confirmed `Legacy session identity mismatch`.
  It rechecks the ID and exact path under DSH's write lease. Other failures,
  healthy histories, and session working-directory files are left untouched.
- Does not rewrite host configuration or repository instruction files.
  Repository identity, run identity, lease, revision, and integrity mismatches
  fail closed.

## Processes and network

- Source-backed index reasoning is active by default in both compatibility and
  configured core: admitted DSH provider/model, up to eight bounded calls per
  workspace per UTC day across extraction, bridging and entailment checking.
  It sends permitted project memory, never uses a substitute model, adds no
  generation call during retrieval, and holds uncertain sends for explicit
  retry. [Modes, budgets and controls](docs/index-reasoning.md).

- Repository-relative final verifiers and backup operations may run restricted
  subprocesses only when the corresponding Kiokuko operation explicitly
  requests them. Ordinary development uses the explicit owned `kioku_exec`
  shell tool described below.
- Diff review runs fixed-argument, read-only Git subprocesses. A user-started
  analysis sends the selected, sanitized snapshot and limited Kiokuko context
  to the exact DSH model connection chosen in the review UI. It supplies no
  tools and does not automatically retry or choose another model.
- Skill discovery and source retrieval can contact GitHub or skills.sh when
  enabled by configuration.
- Remote embedding requests can contact the configured endpoint. Remote
  embeddings are disabled by default; local embedding state remains separate.

- Automatic memory review is active by default: every eight completed human
  turns can send bounded session evidence and project candidate snapshots to
  that session's configured DSH provider/model, with up to 12 worker dispatches
  per project per UTC day. Ordinary/Deep finalization and configured Evolution
  have separate calls and budgets. Provider-internal retries are not counted as
  additional worker dispatches. [Controls and limits](docs/auto-memory-review.md).
- `/kioku-memory-review exclude session` persists a session-wide automatic
  capture exclusion across these paths. It blocks future dispatch and adoption,
  attempts local cancellation, and cannot retract already transmitted data.
  Existing logs/memories and explicit memory tools are unaffected.

## Credentials and optional dependencies

- Explicit `kioku.typesafe:evaluate` calls transmit only their selected state and
  questions to `https://api.typesafe.ai/v1/systemone` from the host. Requests and
  responses are capped at 256 KiB; no automatic retries or redirects. The worker
  remains without network access. Results can be journaled as ordinary Lisp
  evidence, but cannot grant proposal approval. Cancellation cannot retract data
  already sent. [Setup and examples](docs/typesafe.md).
- `/kioku-typesafe-key` writes/removes only the `TYPESAFE_API_KEY` reference through
  DSH's optional credential provider. Inherited environment precedence is preserved.
  Without that provider, evaluation can read the host environment but storage is
  unavailable. Keys never enter worker environments, Kiokuko storage or command
  results. Command arguments are not recorded; the key remains visible while typing.

- GitHub and embedding credentials are optional user-provided environment or
  configuration values. They are not bundled in the package and are not
  persisted by the plugin.
- `@huggingface/hub`, `@huggingface/transformers`, and `sqlite-vec` are optional
  peer capabilities. They are not silently installed by the minimal package
  path and are required only by the feature that explicitly uses them.
- `@deepseek-ai/cordis` is the host peer dependency. The loaded plugin temporarily
  wraps the JSONL service's `open` method for legacy-history compatibility and
  restores it on unload. It does not change DSH's installed code or event catalog.

## Installation lifecycle

The only npm lifecycle hook is:

```text
prepare = npm run build
```

It builds the package from the fixed source checkout. It does not modify a DSH
profile, contact an external service, or edit user configuration. A Git source
install must pin a full commit and authorize the exact generated archive key
with pnpm `allowBuilds`; the npm tarball already contains `dist/`.

After `pnpm dsh plugin --profile web update kiokuko-dsh --latest`, reload the DSH
plugin or restart DSH. The newly loaded package synchronizes the standard Skills
before the first conversation; npm installation itself does not write them.
Other agents that cache `~/.agents/skills/` must reload their Skill catalog.
`natural-japanese-output` is deployed under `japanese-translation-for-oss-models/`,
matching its bundled directory; its public Skill name remains unchanged.

## Failure boundaries

`/deep-planning` creates native read-only child agents using explicitly selected
DSH model connections. It stores input, configuration snapshots, bounded source
excerpts, attempts, estimated usage and answers in the configured database.
Source excerpts and the problem are sent to those configured model providers.
It offers no shell, mutation, arbitrary MCP or further child-spawn capability.
Deep memory extraction shares the request budget. Unknown Deep calls and memory
extractions are not automatically resent after a crash. Deep children inherit
only their exact parent's existing AgenticReplay recording choice. See
[Deep planning](docs/deep-planning.md) for limits and recovery behavior.

Missing optional dependencies, unavailable external services, stale or
ambiguous run state, failed verifier processes, and integrity or ownership
conflicts are reported as failures or unavailable states. They are never
converted into normal success or silently redirected to another repository or
run.

## AgenticReplay recordings

`agenticReplay.enabled` defaults to `true`, including in the installed bundle configuration.
This enables the feature, and configuration also approves it: each interactive
session is recorded without a question, and delegated or managed child sessions
follow the same default without ever being asked. `agenticReplay.askOnStart: true`
restores the per-session question instead, and child sessions then need an
explicit `/kioku-agenticreplay start`. Default recording, an affirmative answer or
`/kioku-agenticreplay start` authorize capture. Choices are
saved in SQLite and outrank the default, so a saved refusal keeps that session
unrecorded; with `askOnStart: true`, skip/cancel or unavailable UI continues
without recording.
Set it to `false` and reload to disable the feature. The runtime dependency
`agenticreplay` uses `>=0.1.0 <1.0.0` and installs automatically through npm.
Kiokuko resolves its bundled core, schema and viewer libraries from that package. No extra installer,
startup subprocess, automatic package repair, or network transmission is added.
The dependencies are Apache-2.0; the [upstream license](docs/AGENTICREPLAY-LICENSE.txt)
and viewer credit are retained. Disabled recording never initializes AgenticReplay or creates trace files.

After an affirmative session choice or start command, projected model content and tool final results are
written to `<verified workspace>/.agenticreplay/runs`, or under
`<Kiokuko data directory>/traces/projects/<workspace hash>/.agenticreplay/runs`.
For AgenticReplay, the main database holds the session/run index and recording choices, not log bodies. `show` and `export` require
the exact native command agent/session; no AgenticReplay HTTP API or model tool exists.
Offline HTML is written only to `.agenticreplay/exports/<run ID>.html`.

Traces and HTML can contain sensitive source and conversations. Known secret
patterns and credential-shaped fields are removed before writing, but arbitrary
secrets cannot all be recognized. Use `capture.content: metadata` to omit bodies,
arguments and result content. Reasoning is excluded unless separately enabled;
environment variables, replayState, image bytes and attachments are excluded.
New directories/files use 0700/0600 and unsafe existing modes/symlinks are refused.
`.agenticreplay/.gitignore` excludes new stores from Git. Exports are never published or
uploaded automatically. Deletion and disabling instructions are in
[AgenticReplay recording](docs/agenticreplay-recording.md).
# Optional Common Lisp mode

With lisp.enabled: true, Lisp runs in supervised workers with the normal user environment and child processes. It coexists with ordinary tools; worker failure does not restrict normal coding. Kiokuko-owned kioku_read/write/edit/remove/exec/result use Node filesystem/process APIs, independently of stock DSH filesystem/bash sandbox and approval configuration. DSH tool identity, Plan/goal state, cancellation and admitted execution ownership still apply.

Project edits, development-related external reads, PATH commands, builds/tests, generated/temp/disposable artifacts, helper compilation/registration and routine Kioku saving need no additional approval. Source/data deletion and existing durable user DB mutations require concrete confirmation. Declare destructiveTargets for such commands. Arbitrary Lisp/shell code is not a security sandbox; unclassified code is not rejected merely because static side-effect analysis is impossible. Direct effects bypassing the owned tools have no host verification receipt.

Host receipts record operation/run/session/generation, cwd, sanitized command, file hashes, process exit/signal/cancel/timeout, complete-output digest and test summaries before preview truncation. Environment variables and full outputs are not persisted. Known secret-bearing command/output text is redacted, but arbitrary secrets cannot all be recognized. Process groups are terminated on cancellation. Background results are collected without replaying effects.

Receipts and source-bound checks feed existing completion/memory application and candidate finalization. Related source/test/config edits make checks stale; unrelated generated files do not. Saving failure is explicit and does not undo or rerun development. Interrupted started records remain unknown after restart. Memory candidates carry evidence references and current source freshness; evidence never automatically verifies a generalized lesson. Legacy profile approval settings still load; destructive review cannot be disabled by their ask/auto values.

See [Common Lisp setup and recovery](docs/lisp.md) for commands and limits.

# Configured typed decisions

`modelAutoMode.mode` defaults to `off`. When enabled for an admitted normal task, it sends only that task's text, task type, attachment kinds and configured route descriptions to the selected ready Jev or Laya backend. It requires the registered `openai-codex` provider, live model capability checks and the native token meter. It stores route identities, digests, binding, status and timing in Kiokuko SQLite; it does not duplicate task text or credentials there. `observe` performs the classifier call without changing the DSH request model. A manual picker selection takes priority. No provider substitution, automatic implementation retry or global Web model change occurs. `/kioku-model-auto off` disables the current session; setting `modelAutoMode.mode: off` and restarting disables saved session overrides.

With `typedDecisions.mode: auto` (default), the host may send the current request,
installed Skill descriptions, sanitized candidate plan or explicitly selected Lisp
evidence to the configured adapter. TypeSafe uses its fixed HTTPS endpoint and
DSH-managed TYPESAFE_API_KEY. Nimble requires an explicit complete HTTPS or loopback
HTTP endpoint and model; an optional separate bearer reference is resolved through
DSH. Laya-CoreML uses an explicitly configured owner-access Unix socket (default
`~/Library/Caches/laya-coreml/worker.sock`) from the host, with bounded v1
health/predict requests and cancellation. Existing strict workers additionally
verify a pinned runtime fingerprint; ordinary start-laya workers do not expose one. It does not resolve cloud
credentials or grant socket access to the protected Lisp worker. The optional
Python worker is installed/restarted explicitly by the user, never by DSH. Credentials never enter workers, prompts, logs or Kiokuko SQLite. No redirects,
HTTP retries, provider substitution or runtime/model installation occur. `/kioku-decisions
status` reports configuration, limits and the last fallback without a network call.
Review fallback sends the full sanitized plan to the exact configured `roles.check`
model with no tools. Typed answers grant no permissions or execution approval.

With `memoryReuse.mode: auto` (default), eligible retrieval candidates can also be
sent after the full candidate set passes memory capability checks and a synthetic
readiness probe succeeds. Only the current task/constraints and complete sanitized
`renderMemoryFields()` projections are transmitted. Internal record IDs, revision
receipts and raw source records stay local. The first nonempty eligible selection
triggers the probe; startup and empty retrieval do not. Set `memoryReuse.mode: off`
to disable this additional use without disabling other typed decisions. No source
memory, trust level or scope is changed. See [memory reuse](docs/memory-reuse.md).

With `semanticCompaction.mode: auto` (default), automatic context pressure can also
send a bounded, redacted classification view of conversation text, tool arguments,
result statuses, sizes and excerpts to the same ready backend. Attachment bytes,
replay metadata and raw provider output are excluded. Accepted decisions can shorten
eligible old tool results through DSH's append-only history protocol; original log
events remain available. They never grant execution authority or change stored Lisp
values. Set `semanticCompaction.mode: off` to disable this use independently.
See [semantic compaction](docs/semantic-compaction.md) for protection and failure behavior.

`/kioku-decisions use jev|laya|nimble` performs a bounded synthetic probe and
saves the selected configuration in Kiokuko SQLite for the repository and base
plugin configuration. Laya health discovery selects the supported protocol from the local
worker. `/kioku-decisions install-laya` reuses a running worker through the same
selection flow or shows setup instructions; it does not install or replace files.
No credential value is stored in this selection. Existing request
bindings remain immutable; the command does not edit DSH profile files or restart
DSH or the worker. `use default` restores the plugin configuration.

<!-- kiokuko:runtime approval-policy -->
## Profile-wide Lisp approval policy

`lisp.approvalMode` defaults to `ask`; auto-approval is never inferred from an
unknown request or from selecting Lisp. Ordinary questions keep normal execution
without a Lisp choice or an approval selector in the chat composer. Once a task
is identified as coding implementation or debugging, the existing coding choice
can offer protected Lisp or normal execution; coding plans do not require Lisp.
Auto-approval is an explicit opt-in through General settings,
`/kioku-lisp approval auto`, or “Auto-approve all Lisp actions for this profile and
continue” in a Lisp approval dialog. Use `/kioku-lisp approval ask` to return to
manual consent. Explicit configuration and saved profile settings persist across
chats and restarts and override the default; changing the default does not revoke
a previously saved choice.
All Lisp permission categories are covered, including file restoration, host
verification, public npm package operations, and shared-function changes.

Follow the current host-reported mode. In auto mode execute authorized work
without asking whether to submit, resubmit, run tests, or apply changes. Ask only
for missing intent that materially changes the work. In ask mode submit the
operation directly to the host approval dialog without an extra conversational
permission question. Earlier references to human approval describe ask mode.
Explicit refusal, cancellation, stale inputs and unknown outcomes still stop
execution; changing mode does not replay completed or refused operations.
Identity checks, protected paths, backups and journal recovery remain enforced.
<!-- /kiokuko:runtime -->

Pinned DSH stores this setting in the native `kiokuko-lisp` namespace, keyed by
the host-owned profile identity. Current DSH exposes `lisp.approvalMode` through
the native `kiokuko-dsh` configuration form and saves its profile patch. This
compatibility difference does not change the controls or scope. No separate
preference file or database migration is used.

## Web model management

Settings → Kiokuko Models and `/kiokuko model` permit explicit human connection,
login, API-key replacement, logout, model discovery and selection. Non-secret settings
are profile-local. Credentials share dsh-auth's existing canonical store and locks;
logout affects dsh-cli too. The authenticated Web transport protects the JSON POST
operations. No secret enters model-visible commands or ordinary settings responses.
Infron sends the explicitly selected Standard/Flex tier; it does not silently change
tier on failure. [Storage, permissions and recovery](docs/kiokuko-models.md).
