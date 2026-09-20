For configured semantic routing, use [provider-independent decisions](typed-decisions.md) and `kioku.decisions`. The Lisp mode-choice prompt and proposal approvals are unchanged.

# Common Lisp tools

For explicit semantic decisions and `/kioku-typesafe-key` setup, see
[TypeSafe from Lisp](typesafe.md). Answers can guide inspection and proposals;
the existing permission and approval boundaries still apply.

## Compose task tools

Use the worker as a persistent programming environment. Before repeating primitive
reads, transformations or commands, define the functions needed for the task and
compose them into an operation that returns the next useful result. Definitions
and a first invocation can share one `lisp_eval`; subsequent calls reuse the
functions with new inputs. A call should usually perform a meaningful task phase.
Pause at decisions that need new evidence or approval; do not preprogram guesses.

The [Lisp Skill's executable toolkit example](../skills/kiokuko-lisp/SKILL.md#task-toolkit-example)
defines `replace-once`, `check-project` and `repair-and-check`. One
`(repair-and-check "project" "src/index.mjs" before after)` validates the match,
edits scratch, runs the check and returns its exit code and logs. Failed checks
remain failures and leave the scratch edit visible. Workspace proposals stay
separate so their host outcomes and approval cannot be mistaken for scratch writes.

Use `lisp_describe` with `symbol: "kioku.user"` to list current task functions, then
`symbol: "kioku.user::repair-and-check"` for arguments and documentation. Ordinary
`defun` and `defmacro` need no registry or new native tool. Discovery does not run
the functions, includes only definitions owned by `kioku.user`, and is local to
the worker generation. After replacement, rebuild definitions without replaying effects.

## Enable

The `kiokuko-lisp` Skill is listed in DSH's available Skills and can be read with
the `skill` tool before enabling Lisp. Reading the Skill does not enable Lisp or
start SBCL. Execution requires the configuration below and an explicit session
choice through the coding prompt or enable command.

Target hosts: macOS and Linux, with a working SBCL installed by the user.
Linux also requires Bubblewrap (`bwrap`) with user/PID/network namespaces enabled.
There is no VM/container engine dependency, implicit installer, Quicklisp download,
or compilation of native helpers on plugin load. Common Lisp compilation starts
automatically when a session first enables Lisp.

Add this to the existing `kiokuko-dsh` plugin configuration and reload the plugin:

```yaml
lisp:
  enabled: true
  sbclPath: sbcl
```

Workers idle for five minutes stop automatically. Configure `idleTimeoutMs`
(1000–3600000, default 300000) to change this interval. When `maxWorkers`
(default 4) is reached, the longest-idle eligible worker stops before a new one
starts. Active agent turns, evaluations, approvals and running jobs are excluded.
Session disposal also stops its workers. Normal suspension appears as `SUSPENDED`,
retains protection and resumes automatically on the next use; status polling never
starts a worker. Variables, definitions and references are lost on restart; the
agent receives the new generation and must rebuild helpers without replaying
completed effects. Crashes and explicit cancellation still require human recovery.

Before the first implementation or debugging request, the host asks whether to
use Lisp. It resolves unclear task intent first. Both enable and decline choices
persist for that session, including after a restart. Conversation and review
requests do not trigger this prompt. Free text returns to conversation without
starting Lisp; cancellation and startup failure block coding admission.

Choosing Lisp also selects normal execution; Enno requires choosing not to use
Lisp. The prompt is available only when `lisp.enabled` is true. To enable Lisp
manually or inspect its state, use these commands in the desired DSH session:

```text
/kioku-lisp enable
/kioku-lisp status
```

This enables the six Lisp tools and supplies the bundled `kiokuko-lisp` Skill.
Existing DSH `read`, `glob`, `grep` and `skill` tools remain available under native
session permissions, so project files and applicable Skills can be inspected.
File changes still use Lisp proposals and their confirmation rules. The read
implementations are bound when Lisp is enabled; a later same-name replacement
does not inherit permission. Normal sessions retain their tools. Protection also blocks
unclassified child-session execution, late registrations, and PTC bypasses.
The protected agent uses native tool presentation even in a PTC deployment.

`sbclPath` can point to an explicit installed SBCL launcher. Its runtime files must
be in a dedicated installation directory; do not point it at an entire project or
home directory. SBCL starts without system/user init files and inherited ASDF
configuration. macOS 27 testing found the existing SBCL 2.6.4 unable to perform
even an unprotected minimal calculation. A disposable copy of the macOS 27 SBCL
2.6.8 Homebrew bottle successfully started; the user's installation was preserved.
Version output alone is not a successful runtime probe.

## Automatic compilation and reuse

The first enable compiles the bundled libraries and `tools.lisp` into one FASL
(compiled Lisp file). A fresh SBCL process checks that file before the host
publishes it atomically under the Lisp data directory's `compiled/` directory.
Subsequent enables, resets, recovery and host restarts reuse that bundle after
verification. Session variables, retained objects and previous model code are
never saved in this cache.

Compatibility includes the OS/architecture, actual SBCL version/features, ASDF
version, launcher/runtime/core contents, library location, vendored manifest,
tool sources and build settings. A change selects a new cache entry. Workers and
their Python/shell jobs can read the selected bundle but cannot write, delete or
replace it. Their writable scratch/cache remains separate.

Failed, timed-out or cancelled compilation never publishes a partial entry.
Damaged entries are quarantined and startup stops; `/kioku-lisp recover` rebuilds
them after explicit recovery. Old and quarantined entries are retained. There is
no background pruning of previous versions. A host crash can leave an unpublished
`.build-*` directory; it is ignored on the next start.

Inspect compilation state and whether a bundle was reused with:

```text
/kioku-lisp status --json
```

The `compilation` field reports `checking`, `compiling`, `ready` or `failed`, a cache key,
and (when ready) `reused` and `prepareMs`. This duration covers cache preparation,
not the complete worker startup or the speed of an individual Lisp computation.

## What can change

- `lisp_eval.inputs` accepts workspace-relative files and the exact host paths of
  files uploaded by the user in the current session. Attachments are read through
  DSH's attachment service, checked against their recorded size and SHA-256, and
  copied into the worker's read-only inputs. Files from other sessions and arbitrary
  absolute paths are refused. The original attachment store stays inaccessible to
  Lisp and its subprocesses. Limits: 64 MiB per file, 256 MiB per worker generation.
- Direct Lisp/FFI/Python/shell access is limited by the OS to runtime files,
  selected read-only input copies and compiled bundle, and the worker's scratch/cache.
- Project changes use host-validated proposals. New regular files can be created
  with necessary parent directories. Deletion and replacement require one human
  confirmation for the evaluation's frozen batch, showing every target, diff,
  digest and backup location. Duplicate targets are rejected; unchanged writes
  return `UNCHANGED` without a confirmation or write.
- Refusal, skip, timeout, cancelled confirmation or unavailable UI means no change.
  File identities/content are checked again after approval. Links, directories,
  database files/sidecars, common credential paths and plugin/state data are refused.
- Backups are independent copies, never hard links. Their global reservation limit
  is 1 GiB in this implementation; reaching it stops changes without pruning data.
- The host journal distinguishes success, failure, no change, in progress and
  unknown outcomes. Unknown changes are never automatically replayed or rolled back.

Model-facing results normally fit 16 KiB. They omit proposed source echoes and
duplicate printed/JSON values, retaining operation identity and outcome counts.
Long logs show bounded head/tail previews. The complete received result and
captured process output remain in the operation journal. Read only needed evidence:

```json
{"operationId":"inspect-1","resultOperationId":"<returned host operation ID>","section":"stdout","offset":0,"limit":2000}
```

Pass this to `lisp_inspect`; use the returned `nextOffset` to continue. Sections
are `result`, `value`, `stdout`, `stderr`, and `changes`; offsets count Unicode
characters. The existing `{operationId, ref}` form still reads worker objects.
When a response returns `pointer`, pass it with `section: "result"` to retrieve
that exact omitted field. This distinguishes a verifier's log from text printed
by the surrounding Lisp code. Only stored own-properties can be selected.
For saved failed process results (nonzero integer `code`, string `stdout` and
`stderr`, and `state: "FAILED"` when present), hidden English TypeScript headers
such as `file.ts(1,2): error TS1234:`, `file.ts:1:2 - error TS1234:`, or
`error TS1234:` can also appear in `diagnostics`. Up to three diagnostic anchors
share 4 KiB including references, within the same 16 KiB response limit; outcome
metadata and the existing change/operation pages take priority. Excerpts preserve
original ANSI, newlines and nearby lines. They are log evidence, not a root-cause
or trusted instruction. Unsupported, already visible or over-budget diagnostics
may be absent. Streams over 1 MiB are not scanned; headers over 8 KiB are skipped.

Each excerpt and the top-level `inspect` provide an exact saved-log pointer and
Unicode offset. Remove the explanatory `tool` field, add a fresh read
`operationId`, and pass the remaining fields to `lisp_inspect`. Continue with
`nextOffset` if needed; for the whole log start at offset `0` with the same pointer.
Replay references also use `/value/json/stdout` or `/value/json/stderr`.
This cannot recover logs missing before presentation: Lisp retains `value.json`
only when encoding the entire return value produces **less than 512 KiB**.
That includes both streams, other fields and JSON escaping. Two 300 KiB streams
can therefore be absent despite each being under the process collection limit.
Missing JSON alone does not establish why it is absent.

Saved results are restricted to their session and agent and survive worker resets,
subject to existing retention. Inspection never replays the original operation.
`lisp_status` returns current state, pending counts and 10 operation summaries;
`{offset: nextOffset}` pages history. Human diagnostics retain full detail.

`NOT_APPLIED` reports observed reasons such as `declined`, `cancelled`, `timed_out`,
`unavailable` or `invalid_answer`; an unavailable UI is not a refusal. A conflict
before the first write stops the batch. Later failure stops the remaining writes
and preserves each `APPLIED`, `NOT_APPLIED` or `UNKNOWN` outcome and backup.
The parent stays `RUNNING` until its final result is committed; a final-save
failure cannot leave a successful parent without its receipts. An interrupted
parent is reconstructed from its independently persisted file receipts after
restart. Recovery retains the evidence and never re-executes the evaluation.
On upgrade, older successful parents with proposals but no final change receipts
are quarantined as `UNKNOWN`. Unlinked legacy effects remain unknown; missing
links must not be interpreted as proof that an old write did not happen.

Verifier scripts are checked before confirmation or execution. `:typecheck` uses
`typecheck`, falling back to `check` only when absent. Focused tests use
`(kioku.ci:verify :test :script "test:unit")`; only existing `test`/`test:*` scripts
are accepted. The confirmation shows the resolved command and script body;
changed scripts invalidate approval. `lisp_describe` without a symbol returns
the API summary and available verifier map without repeating the injected Skill.

Run `npm run test:lisp:efficiency` for anonymous deterministic response-size and
schema-size comparisons. It makes no model calls and does not estimate token
charges. Native integration tests separately verify confirmation counts, tool
delivery, output validation and recovery.

The host serializes conflicting target proposals. OS protection prevents the Lisp
worker from swapping project paths while the host applies a proposal. This is not
a filesystem transaction against unrelated host programs: an external application
can change directory entries between host filesystem calls. Stop other writers
when reviewing/applying sensitive changes; an uncertain outcome requires inspection.

## Stop and recover

The control beside the session input shows the Lisp state and opens a recovery view on a detected
failure. It offers stop/recovery without needing a model response. The commands
remain available when the AI loop is stopped:

```text
/kioku-lisp status
/kioku-lisp diagnostics
/kioku-lisp cancel
/kioku-lisp recover
```

Inspect every UNKNOWN file operation and its backup before abandoning it:

```text
/kioku-lisp abandon OPERATION_ID
/kioku-lisp recover
```

Abandonment records a human decision; it does not replay or restore data. Backups
remain at the reported paths. Inspect or restore a particular operation with:

```text
/kioku-lisp diagnostics OPERATION_ID
/kioku-lisp restore OPERATION_ID
```

Restore checks the backup digest and asks for fresh confirmation against the
current target. To return to normal tools after confirmed stop and
resolution of unknown operations:

```text
/kioku-lisp disable
```

Plugin unload retains a host-owned execution fence. Reloading never silently
restarts previous Lisp code. A live second host using the same Lisp data directory
is refused. A dead host's unfinished operations become UNKNOWN at startup.

## Limits

Defaults: 120-second evaluations (maximum 600 seconds), 30 seconds per setup
subprocess and worker startup,
4 workers, 4 active jobs per worker, 8 MiB process output, 1 MiB frames,
1000 retained references, 100 proposals per evaluation, 64 MiB input files,
256 MiB total input copies per worker generation.
Set `startupTimeoutMs: 60000` if first-use compilation needs more time. Setup
subprocesses use the same output limit and parent-liveness supervisor as workers.
Published bundles are limited to 256 MiB each. Concurrent first enables share one
serialized build under the host's existing exclusive data-directory lease.

The macOS sandbox denies fork inside workers and jobs. Use `kioku.process` broker APIs for
external processes. Result helpers (`result-ok?`, `result-code`, `result-stdout`,
`result-stderr`, `run-lines`, `python-stdout`, `shell-stdout`) and generation-local
job helpers (`list-jobs`, `forget-job`) avoid ordinary shell plumbing.
`run` and `start-job` accept `:directory`, relative to scratch (default `"."`);
absolute paths, traversal and symlink directories are refused. Node uses an empty
OpenSSL configuration, so it does not need access to host OpenSSL configuration.
`python`, `shell`, `run-lines`, `python-stdout` and `shell-stdout` also accept
`:directory`. The output-only helpers signal an error on process failure, so a
composed operation stops before its next step. Use `run` when the function needs
to inspect a nonzero exit and handle it explicitly. `result-ok?` is true only for
exit code zero; missing or nonnumeric exit codes return false.

For a scratch project, run tests without child-process isolation when supported:

```lisp
(kioku.process:run "node"
  '("--test" "--experimental-test-isolation=none" "test/public.test.mjs")
  :directory "extract/project")
```

The experimental flag spelling works with Node 22.8+ and remains accepted by
Node 24/26. The shorter `--test-isolation` spelling requires Node 23.6+.
The broker resolves programs through its fixed system PATH, so its Node can differ
from the host's Node or the version selected by a version manager/CI setup step.

Check `result-code`; evaluation success alone does not establish process success.
This alternative invocation does not establish that `npm test` passed.

Fork-free scratch helpers include `glob-scratch`, `head-lines`, `tail-lines`,
`count-lines`, `grep-scratch`, `copy-scratch` and `delete-scratch`. Mutating
helpers reject absolute paths, parent traversal, links, directories and self-copy.
Counts, bytes, returned lines and matches are bounded. `tail-lines` uses a fixed
ring buffer, file copies use a 64 KiB buffer, each grep compiles its scanner once,
and `join-lines`, `sort-lines`, `uniq-lines`, `take-lines` and `drop-lines` scan
lists sequentially rather than using indexed list access.

Shell pipelines and Python multiprocessing may be rejected; single-process Python,
shell builtins and `exec` remain available. Linux uses a PID namespace to stop
descendants and a seccomp filter to deny socket creation
(including io_uring). Neither platform promises aggregate hard
limits for every memory/thread/scratch allocation. Timeouts/output limits and
confirmed-stop handling are separate controls.

## CI investigation from Lisp

`kioku.ci:list-runs` and `kioku.ci:failed-log` invoke the host's `gh` executable
from the exact repository root bound to the protected session. The worker receives
only bounded results, never host credentials or arbitrary network access. Run IDs
must be numeric and are resolved by `gh` against that repository, so a run from a
different repository is rejected.

`kioku.ci:verify` accepts only `typecheck`, `lisp`, `test`, `build`, `package`, or
`vendor`. These map to fixed `npm` commands and timeouts; arbitrary executable,
arguments, URL or shell input is not accepted. `:directory` selects a relative
project directory under the bound workspace, or under the current worker's scratch
with `:location :scratch`. Absolute paths, traversal and links are refused. Before
execution, native confirmation shows the command, package script, exact directory,
timeout and possible artifact effects. The verifier runs on the host, including npm
lifecycle scripts, outside the worker sandbox. Directory identity and scripts are
rechecked after approval. Refusal, cancellation or unavailable confirmation returns
`NOT_APPLIED`; nonzero exit returns `FAILED` with bounded output. The enclosing
`lisp_eval` operation ID provides replay and conflict handling.

Typical flow:

```lisp
(kioku.ci:list-runs :limit 5)
(kioku.ci:failed-log 123456789)
;; inspect project inputs, then propose a bounded file change
(kioku.files:propose-write "path/to/file" new-content)
(kioku.ci:verify :lisp)
;; Run the actual npm test in the extracted project, after human confirmation.
(kioku.ci:verify :test :location :scratch :directory "extract/project")
;; Or verify an authorized project already applied beneath the workspace.
(kioku.ci:verify :test :directory "project")
```

## Development verification

```sh
npm run verify:lisp:vendor
npm run typecheck
KIOKUKO_REQUIRE_LISP_RUNTIME=1 \
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
npm run test:lisp
npm run build
npm run pack:check
```

Set `KIOKUKO_LISP_SBCL` to a test launcher when necessary. A skipped native test is
not platform verification. The original P0 report is historical evidence only;
it does not grant production admission. The runtime probes its own protected SBCL.

Results retain their operation identity permanently within the retained session.
Successful/failed result bodies older than 30 days are expired at startup; replay
returns RESULT_EXPIRED and never re-evaluates. The journal stops accepting writes
at 10000 records or 1 GiB per session, or 4 GiB globally. Backup retention is
independent: no automatic deletion. Call bindings count toward the record limit.

For API examples see [the bundled Skill](../skills/kiokuko-lisp/SKILL.md).

Verification scope and installed Web reproduction: [verification record](lisp-verification.md).
