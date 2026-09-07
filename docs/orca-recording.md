# Orca recording in DSH

OrcaReplay records observations from the existing DSH process. It does not start
another DSH. `@orcareplay/core`, `@orcareplay/schema` and `@orcareplay/viewer`
accept **>=0.2.1** as ordinary dependencies and are installed automatically with
`kiokuko-dsh` by npm/pnpm. No separate Orca install or global CLI is required.
This range includes 0.3 and later stable releases; future API compatibility is not guaranteed.
Lockfiles retain the tested resolution (currently 0.2.1); they do not refresh on each launch.
The trace manifest records the installed core version.
For manual dependency updates and restarting DSH, see [the update guide](dsh-plugin.md#update).
The integration is tested against **DSH 0.1.2-rc.1**. The native E2E verifies
installed package versions before executing. The trace labels that version as
`verifiedDshVersion`; it does not invent an actual host version when the host
does not expose one. See the bundled [Apache-2.0 license](ORCAREPLAY-LICENSE.txt).

## Enable and use

In the existing Kiokuko loader row's `config`, set:

```yaml
enabled: true
orca:
  enabled: true
  storage: project
  capture:
    content: redacted
    reasoning: false
```

Reload the plugin. Omitted `orca` settings default to disabled. Recording starts
on the next attributable model/tool observation. Past calls are not captured.
Use the native session's human command interface:

```text
/kioku-orca status
/kioku-orca stop
/kioku-orca list
/kioku-orca show run_<id>
/kioku-orca show run_<id> <cursor>
/kioku-orca export run_<id>
/kioku-orca start
```

Replace `run_<id>` with the exact ID returned by `list`. Stop finalizes recording
without stopping the task or closing the shared database. Start opens a new
recording generation; it never reopens old events. `show`/`export` accept only
completed traces from that native session and workspace. Cursors expire when the
plugin reloads. Lists contain the most recent 200 generations.

`status` distinguishes disabled, available and unavailable capability, trace
state, missing/unresolved observations and index persistence failure. An empty
trace means no attributable observation has started. `completed` means the chosen
recording scope was persisted without known missing events; it does not mean the
task succeeded. Unknown usage is not measured zero. Process exit codes are absent.

## Storage and contents

The default is `<verified session workspace>/.orca/runs/<run ID>`. The manifest's
`cwd` is the actual session directory. Worktrees have separate roots. A non-Git
session uses its verified directory. No process-cwd or DSH_HOME fallback is used.
`storage: data-dir` selects
`<Kiokuko data directory>/traces/projects/<workspace hash>/.orca/runs` and respects
the existing `KIOKUKO_DATA_DIR` setting. Hashing a path does not anonymize it.

`redacted` preserves text after known secret-pattern filtering. It cannot detect
all arbitrary secrets. `metadata` omits message bodies, arguments and tool result
bodies. Neither mode records environment variables, replayState, attachment bytes,
raw HTTP, shell frames or raw MCP transport. Reasoning defaults off. Auxiliary
compaction/title calls default off (`includeAuxiliary: true` opts in); requests
without an exact session binding remain excluded. Unknown chunks are counted as
unsupported. Model errors/abort reasons and final post-policy tool results are
recorded without changing native values or exceptions.

These are **DSH internal observations**: `httpCapture=false`,
`filesystemSnapshot=false`, `exactReplay=false`. Orca replay/fork/compare and
reconstructing images or physical HTTP retries are not supported. Tool calls are
represented once at admission; model tool-call blocks remain response content.

HTML is an offline file at `.orca/exports/<run ID>.html`. It contains the same
sensitive projected data as the trace. It is escaped, generated through the public
Orca viewer, and never uploaded. No arbitrary output path, file URL, `last`
selector, model-facing command or Orca HTTP route is accepted.

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

Stop active recordings, set `orca.enabled: false`, and reload. This retains traces
and the existing Kiokuko database/session mirror. To remove a recording, stop it
first, then delete its exact `.orca/runs/<run ID>` directory and associated
`.orca/exports/<run ID>.html` file in the verified workspace or data directory.
The small historical index can remain; a missing artifact is refused by the reader.
Do not delete/reinitialize the Kiokuko database to remove recordings.

If a package is missing/corrupted, reinstall `kiokuko-dsh` using the same package
manager/profile used for its installation. The plugin never launches an installer.
Core/schema failure disables recording; viewer failure disables reading/export
while recording can continue. Prompt-only hosts do not initialize Orca. Custom
`kiokukoDsh` hosts must provide `DshOrcaHostServices`, exact native bindings,
observers and an idempotent shutdown that drains recording before closing their DB.
