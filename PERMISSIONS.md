# Kiokuko DSH permissions

Kiokuko DSH is a local-first DeepSeek Harness suite. The DSH host owns profile
lifecycle and the plugin only uses the effects required by the selected
Kiokuko operation.

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
- On enabled plugin load, synchronizes all eight bundled Skills and their
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

## Credentials and optional dependencies

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
