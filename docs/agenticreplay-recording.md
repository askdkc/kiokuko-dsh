# AgenticReplay recording in DSH

AgenticReplay records observations from the existing DSH process. It does not start
another DSH. The ordinary npm dependency
[`agenticreplay`](https://www.npmjs.com/package/agenticreplay) supplies its bundled
`@agenticreplay/core`, `@agenticreplay/schema`, and `@agenticreplay/viewer` libraries.
Node resolves them from that distribution without fixed installation paths.
Kiokuko calls the libraries in process; it does not launch the CLI or install packages at startup.
The supported range is `>=0.1.0 <1.0.0`: patch and minor releases in the pre-1.0
API family, including 0.1.2 and 0.2.0, can be selected by a dependency update
without editing Kiokuko's dependency range. Prereleases and 1.0+ are excluded.
Lockfiles retain the tested resolution; installing or restarting does not update
it automatically. A permitted range is not proof of future API compatibility.
The trace manifest records the installed core version.
Each recorded final model request also includes a bounded manifest of host-owned
context sections still present in that request: section ID, digest, byte count,
omitted count, and coverage. It stores no extra section text, and an unobserved
section is never described as delivered. This is request-side provenance, not
proof that a provider processed the bytes.
For manual dependency updates and restarting DSH, see [the update guide](dsh-plugin.md#update).
The integration is tested against **DSH 0.2.1-alpha.2**. The native E2E verifies
installed package versions before executing. The trace labels that version as
`verifiedDshVersion`; it does not invent an actual host version when the host
does not expose one. See the bundled [Apache-2.0 license](AGENTICREPLAY-LICENSE.txt).

## Upgrade from OrcaReplay

The configuration key is now `agenticReplay`, the command is
`/kioku-agenticreplay`, and new recordings use `.agenticreplay/runs` with the
AgenticReplay 0.4.x schema and `agenticreplay_version` manifest field.
Rename any explicit `orca` profile configuration to `agenticReplay` before
reloading, especially an existing `enabled: false` opt-out. The old command is removed; the old configuration key is rejected with an
upgrade error rather than silently ignoring an opt-out. Omitted new configuration keeps recording enabled by default.
Migration 034 copies saved per-session recording choices, including refusals,
into the new index. Historical Orca tables and `.orca` files are retained;
legacy trace rows are not imported, listed, read or converted. The new reader
rejects legacy manifests even if a file is placed in the new directory.

## Automatic setup and use

Installing the Kiokuko bundle configures the recording feature automatically.
Configuration approves recording: at the first native step of a chat the session
is recorded without asking, and only `agenticReplay.askOnStart: true` restores the
per-chat 記録する／記録しない question. The bundled loader row supplies these
defaults:

```yaml
enabled: true
agenticReplay:
  enabled: true
  askOnStart: false
  storage: project
  capture:
    content: redacted
    reasoning: false
```

Omitted `agenticReplay` settings also enable the feature and record. Either the default or
an affirmative answer admits subsequent observations; a refusal leaves the chat
running without AgenticReplay trace files. The decision is saved in Kiokuko SQLite, scoped
to the session ID, workspace, session cwd and storage root; a saved choice
outranks the configuration default, so a session stopped once stays unrecorded
across reloads. While a question is pending, no observations are recorded. A
failed preference write leaves the session unrecorded and reports
`selectionError` in `status --json`; `/kioku-agenticreplay start` can still authorize that
session explicitly. Skipped, invalid, cancelled or unavailable questions continue
without capture. An unanswered question is not repeated on each step; use
`/kioku-agenticreplay start` later (or answer after reloading). With `askOnStart: true`,
hosts without a question UI also require an explicit start command.
Managed Enno worker and delegated child sessions are never prompted. A child
follows the exact decision of the session that owns it: with `askOnStart: false`
it records under that parent's default, and with `askOnStart: true` it records
only when the parent approved, because a question would interrupt managed work.
A child stores no decision of its own, so its work still appears in `.agenticreplay/runs/`
as its own generation, and a managed session without an owning parent records
under the configured default or needs its own explicit `/kioku-agenticreplay start`.

Once a session is approved, the next attributable model/tool observation creates
the trace directory, not package installation. Past calls are not captured.

After updating an older installation, restart DSH to load the new bundle defaults.
An explicit `agenticReplay.enabled: false` in a profile, home, or launch patch still takes
precedence: remove that override or change it to `true` and reload. Preserve other
plugin settings when editing a patch because DSH replaces the whole row config.
Use the native session's human command interface:

```text
/kioku-agenticreplay status
/kioku-agenticreplay status --json
/kioku-agenticreplay stop
/kioku-agenticreplay list
/kioku-agenticreplay show run_<id>
/kioku-agenticreplay show run_<id> <cursor>
/kioku-agenticreplay export run_<id>
/kioku-agenticreplay start
```

Replace `run_<id>` with the exact ID returned by `list`. Stop finalizes recording
without stopping the task or closing the shared database, and saves the session
choice as disabled. Start saves the choice as enabled and opens a new recording
generation; it never reopens old events. `show`/`export` accept only
completed traces from that native session and workspace. Cursors expire when the
plugin reloads. Lists contain the most recent 200 generations.

`status` shows a compact summary: recording state first, then the next command,
storage location and any missing observations. Internal diagnostics are omitted
from the default display. Use `status --json` for the full diagnostic snapshot.

The JSON snapshot distinguishes disabled, available and unavailable capability, trace
state, missing/unresolved observations and index persistence failure.
`sessionRecording` is `awaiting_choice`, `enabled` or `disabled`; with
`askOnStart: false` a session reports `enabled` from its first step unless a
saved refusal exists. `selectionError`
reports unavailable questions or failed preference persistence. Feature capability
`available` alone does not mean this session has opted into recording. An empty
trace means no attributable observation has started. `completed` means the chosen
recording scope was persisted without known missing events; it does not mean the
task succeeded. Unknown usage is not measured zero. Process exit codes are absent.

## Storage and contents

The default is `<verified session workspace>/.agenticreplay/runs/<run ID>`. The manifest's
`cwd` is the actual session directory. Worktrees have separate roots. A non-Git
session uses its verified directory. No process-cwd or DSH_HOME fallback is used.
`storage: data-dir` selects
`<Kiokuko data directory>/traces/projects/<workspace hash>/.agenticreplay/runs` and respects
the existing `KIOKUKO_DATA_DIR` setting. Hashing a path does not anonymize it.

Before creating a recording or exporting HTML, the plugin adds `.agenticreplay/`
to the storage root's `.gitignore` (the workspace root with default storage).
Existing contents and line endings are preserved; repeated use does not duplicate
an effective rule. The internal `.agenticreplay/.gitignore` remains as additional
protection. If the root rule cannot be written safely, recording fails with
`gitignore_protection_failed` without interrupting the native model/tool operation;
HTML export fails without writing an export. Non-Git directories receive the
same rule so a later `git init` also excludes these files.

Ignore rules do not remove already tracked files or published history and can be
bypassed by a forced add. Check `git ls-files -- .agenticreplay` for previously
tracked captures before pushing; remove them from the index and address any
already published sensitive data separately.

`redacted` preserves text after known secret-pattern filtering. It cannot detect
all arbitrary secrets. `metadata` omits message bodies, arguments and tool result
bodies. Neither mode records environment variables, replayState, attachment bytes,
raw HTTP, shell frames or raw MCP transport. Reasoning defaults off. Auxiliary
compaction/title calls default off (`includeAuxiliary: true` opts in); requests
without an exact session binding remain excluded. Unknown chunks are counted as
unsupported. Model errors/abort reasons and final post-policy tool results are
recorded without changing native values or exceptions.

These are **DSH internal observations**: `httpCapture=false`,
`filesystemSnapshot=false`, `exactReplay=false`. AgenticReplay replay/fork/compare and
reconstructing images or physical HTTP retries are not supported. Tool calls are
represented once at admission; model tool-call blocks remain response content.

HTML is an offline file at `.agenticreplay/exports/<run ID>.html`. It contains the same
sensitive projected data as the trace. It is escaped, generated through the public
AgenticReplay viewer, and never uploaded. No arbitrary output path, file URL, `last`
selector, model-facing command or AgenticReplay HTTP route is accepted.

## Limits and failure behavior

Default limits are 4 MiB queued/retained observation data per trace, 16 MiB across
recordings, 256 MiB per trace, and 32 open traces. Budget accounting is conservative
and includes strings, active calls and queued writes. Hitting a bound stops new
observations for that generation and leaves missing-event diagnostics. Resume is
explicit. A single projected event is bounded before serialization; the writer's
one-event allocations and final metadata are additional overhead, so these are
application limits, not an OS disk quota. Use filesystem quotas for a hard bound.

`show` reads at most 200 events and 1 MiB of JSONL/blob data per page. It seeks to a
signed cursor's byte offset without rescanning earlier pages. Oversized single
rows or blobs are refused. Export checks the JSONL stat before reading, then
validates schema, dense sequence, final newline, hashes, unique blob sizes,
manifest counts and the SQLite totals. Defaults: 8 MiB input, 10,000 events,
32,768 inline characters per event, 64 MiB output. A conservative output estimate
can reject a trace below those individual ceilings. Oversized export does not
change the successful recording state. Private temporary output is renamed only
after generation and a second consistency check.

Stop/unload waits up to 30 seconds for admitted observations, including pending
permission decisions. Timeout records unresolved calls and marks the trace
incomplete. Known late results cannot reopen it. This timeout does not interrupt
filesystem I/O: queued writes settle before writer/DB close. A permanently stalled
OS write can therefore delay unload. No cancellation signal is changed.

A failed index update is shown separately in live status. Nonterminal indexed
runs whose owner PID is provably absent are marked incomplete on session listing;
live, inaccessible, unknown or reused PIDs are left alone. Old trace files are
never repaired in place. An unindexed directory remains an orphan for manual
inspection; its ownership is never inferred from a directory name. Do not assume
index and filesystem updates are one atomic transaction.

Same-user malicious filesystem races are outside the security guarantee. Private,
trusted storage parents are required. Existing unsafe permissions or symlinks are
rejected instead of silently chmod-ing user files.

## Disable, remove, and recover dependencies

Stop active recordings, set `agenticReplay.enabled: false`, and reload. This retains traces
and the existing Kiokuko database/session mirror. To remove a recording, stop it
first, then delete its exact `.agenticreplay/runs/<run ID>` directory and associated
`.agenticreplay/exports/<run ID>.html` file in the verified workspace or data directory.
The small historical index can remain; a missing artifact is refused by the reader.
Do not delete/reinitialize the Kiokuko database to remove recordings.

If a package is missing/corrupted, reinstall `kiokuko-dsh` using the same package
manager/profile used for its installation. The plugin never launches an installer.
Core/schema failure disables recording; viewer failure disables reading/export
while recording can continue. Prompt-only hosts do not initialize AgenticReplay. Custom
`kiokukoDsh` hosts must provide `DshAgenticReplayHostServices`, exact native bindings,
observers and an idempotent shutdown that drains recording before closing their DB.
