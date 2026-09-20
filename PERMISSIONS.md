# Kiokuko DSH permissions

Kiokuko DSH is a local-first DeepSeek Harness suite. The DSH host owns profile
lifecycle and the plugin only uses the effects required by the selected
Kiokuko operation.

This document describes the full compatibility package. The
[configured core](docs/core-modules.md) synchronizes only its selected managed
Skills and uses the shared database, intake, ledger and scoped memory. It does
not mount Orca, Deep, advanced-memory workers, session-history repair or the
full browser client. Enno retains the existing compatibility host adapter;
Lisp adds protected execution and its existing explicit approval boundaries.
Omitted managed Skills are preserved on disk. Configured startup rejects unsafe
Skill collisions before mounting its runtime; it does not rewrite `AGENTS.md`.

## Local data

- Reads configured Kiokuko SQLite state, registered project roots, and
  repository metadata.
- Writes the configured Kiokuko database and pre-migration backups, including
  DSH leases, receipts, retrieval state, and embedding state.
- Stores the first native input batch of each governed turn in that database
  for recovery before model or tool execution. This is an input-message copy,
  not a backup of the workspace or whole session. Later step inputs do not
  replace it. Storage failure cannot veto the native turn; observed model or
  tool execution prevents automatic input replay.
- On enabled plugin load, synchronizes all nine bundled Skills and their
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
- Does not rewrite host configuration or repository instruction files.
  Repository identity, run identity, lease, revision, and integrity mismatches
  fail closed.

## Processes and network

- Repository-relative final verifiers and backup operations may run restricted
  subprocesses only when the corresponding Kiokuko operation explicitly
  requests them. The plugin does not provide an implicit model-facing shell
  tool.
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
only their exact parent's existing Orca recording choice. See
[Deep planning](docs/deep-planning.md) for limits and recovery behavior.

Missing optional dependencies, unavailable external services, stale or
ambiguous run state, failed verifier processes, and integrity or ownership
conflicts are reported as failures or unavailable states. They are never
converted into normal success or silently redirected to another repository or
run.

## Orca recordings

`orca.enabled` defaults to `true`, including in the installed bundle configuration.
This enables the feature, and configuration also approves it: each interactive
session is recorded without a question, and delegated or managed child sessions
follow the same default without ever being asked. `orca.askOnStart: true`
restores the per-session question instead, and child sessions then need an
explicit `/kioku-orca start`. Default recording, an affirmative answer or
`/kioku-orca start` authorize capture. Choices are
saved in SQLite and outrank the default, so a saved refusal keeps that session
unrecorded; with `askOnStart: true`, skip/cancel or unavailable UI continues
without recording.
Set it to `false` and reload to disable the feature. The runtime dependencies
`@orcareplay/core`, `@orcareplay/schema`, and `@orcareplay/viewer` with range `>=0.2.1`
are installed automatically by npm/pnpm with this package. No extra installer,
startup subprocess, automatic package repair, or network transmission is added.
The dependencies are Apache-2.0; the [upstream license](docs/ORCAREPLAY-LICENSE.txt)
and viewer credit are retained. Disabled recording never initializes Orca or creates trace files.

After an affirmative session choice or start command, projected model content and tool final results are
written to `<verified workspace>/.orca/runs`, or under
`<Kiokuko data directory>/traces/projects/<workspace hash>/.orca/runs`.
For Orca, the main database holds the session/run index and recording choices, not log bodies. `show` and `export` require
the exact native command agent/session; no Orca HTTP API or model tool exists.
Offline HTML is written only to `.orca/exports/<run ID>.html`.

Traces and HTML can contain sensitive source and conversations. Known secret
patterns and credential-shaped fields are removed before writing, but arbitrary
secrets cannot all be recognized. Use `capture.content: metadata` to omit bodies,
arguments and result content. Reasoning is excluded unless separately enabled;
environment variables, replayState, image bytes and attachments are excluded.
New directories/files use 0700/0600 and unsafe existing modes/symlinks are refused.
`.orca/.gitignore` excludes new stores from Git. Exports are never published or
uploaded automatically. Deletion and disabling instructions are in
[Orca recording](docs/orca-recording.md).
# Optional Common Lisp mode

With `lisp.enabled: true`, `/kioku-lisp enable` starts an OS-protected SBCL for the
current session. It reads bundled runtime libraries and explicitly selected input
copies and a verified compiled bundle, and writes its own scratch/cache. Initial
Lisp enable compiles bundled sources in a supervised sandbox; the host publishes
the completed bundle for read-only reuse. Runtime/compiler/source changes select
a new entry. Invalid entries are quarantined and require explicit recovery. The
host stores operation records and
independent backups beside the Kiokuko database. No credentials or inherited
environment are forwarded, and direct network/host IPC access is denied. The
host may run repository-scoped `gh run list`/`gh run view --log-failed` reads on
behalf of Lisp without copying credentials into the worker. Verification accepts
only six fixed npm targets and requires native human confirmation showing the
command, package script, exact working directory and timeout. The directory may
be the workspace root, a workspace subdirectory, or a subdirectory of the current
worker's scratch. Traversal and symlink directories are refused, and directory
identity and scripts are rechecked after approval. These approved verifiers run
on the host, including npm lifecycle scripts, outside the worker sandbox;
arbitrary shell input is not accepted. Brokered worker programs can select only a
scratch-relative working directory and retain the existing OS restrictions.

File deletion and replacement require the native human confirmation for the exact
proposal. Generic operations reject databases/sidecars, credential paths, links,
directories, plugin files and host state. Refusal, skip, cancellation and missing
confirmation UI never grant permission. Normal tools and child bypasses remain
blocked until a human safely disables the mode. Plugin unload retains the fence.
See [Common Lisp setup and recovery](docs/lisp.md) for commands and limits.

# Configured typed decisions

With `typedDecisions.mode: auto` (default), the host may send the current request,
installed Skill descriptions, sanitized candidate plan or explicitly selected Lisp
evidence to the configured adapter. TypeSafe uses its fixed HTTPS endpoint and
DSH-managed TYPESAFE_API_KEY. Nimble requires an explicit complete HTTPS or loopback
HTTP endpoint and model; an optional separate bearer reference is resolved through
DSH. Credentials never enter workers, prompts, logs or Kiokuko SQLite. No redirects,
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
