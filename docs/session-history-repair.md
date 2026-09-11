# Existing chat history fails to load

`unknown to this harness and not marked ignorable` means DSH refused an event
outside its supported vocabulary. It does not by itself mean that chat content
was deleted. DSH 0.1.5-rc.1 accepts `ignorable` while reading, but its public
`Session.append` does not preserve that option while writing.

Kiokuko now stores execution observations and completion/pause notices in its
own SQLite database. The finalizer still binds observations to the exact run,
workspace, Session, native call sequence and rendered result hash. The Session
header's **Kiokukoの回答 / Kiokukoの状態** action displays saved notices; unread
notices open automatically and are acknowledged after display. Old custom
notice events remain renderable after their log has been repaired.

Once the updated plugin is loaded, opening an affected v3 chat automatically
marks the five historical informational types below as ignorable and retries
DSH's normal reader. This applies to both viewing history and resuming a chat.
It handles the requested session only; installation does not scan or rewrite
other chats. New observations and notices continue to use Kiokuko's database.

The compatibility adapter acquires DSH's native session write lease, validates
the complete candidate with the running JSONL backend, retains an identical
`.bak`, and replaces the file atomically. Event bodies, sequence numbers,
timestamps and fork boundaries are preserved. It refuses active writers,
conflicting backups, symbolic-link artifacts, damaged logs and unrelated
required event types. Automatic repair is limited to v3 JSONL/Zstandard files
up to 64 MiB on disk and 256 MiB expanded. Unloading Kiokuko restores the native
reader and waits for any repair already in progress.

## Explicit diagnostic repair

The scripts remain available for inspecting a particular artifact, older
continuation-source issues, or hosts without the automatic adapter. Finish
active tasks and stop every DSH process using the file before running them.

From this Kiokuko checkout, set the exact `raw log:` path printed in the error
and a built Session format catalog matching the DSH installation that will read
it. Use Node.js 24.16.0 or later:

```bash
session_log='/absolute/path/from-the-error/session.v3.jsonl.zstd'
format_catalog='/absolute/path/to/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'

node scripts/repair-session-log.mjs "$session_log" --catalog "$format_catalog" --dry-run
node scripts/repair-session-log.mjs "$session_log" --catalog "$format_catalog"
```

The same two scripts are included in the npm package. Run them from the installed
`kiokuko-dsh` directory if using a packaged installation. `--catalog` is authoritative;
a different installed catalog is never silently substituted.

The repair validates all Zstandard frames, every JSONL record, and the complete
result through DSH's strict catalog before changing the file. For these exact
historical informational types, it adds only the envelope's `ignorable: true`:

- `kiokuko/evolution-observation`
- `kiokuko/completion-report`
- `kiokuko/execution-status`
- `kiokuko/deep-report`
- `kiokuko/deep-status`

Event bodies, sequence numbers and timestamps are preserved. Legacy Kiokuko
continuation-source fields are also normalized by the existing repair logic.
A byte-for-byte `.bak` is retained and validated output replaces the original
atomically. Re-running an already repaired file makes no changes. A conflicting
backup or temporary file is never overwritten.

Unknown required types, surface-changing custom events, malformed records and
partial compressed frames remain errors. A historical v0 log containing custom
events can also be rejected by the installed catalog's migration policy even
with `ignorable`; this tool leaves that file untouched. It never deletes events,
renumbers history, forces a newer format header or disables DSH's reader checks.

After repair, restart DSH and reopen the affected chat. If reimport detects a
cached-envelope difference, the next native flush refreshes Kiokuko's Session
mirror from the authoritative repaired history.
