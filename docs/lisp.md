# Common Lisp tools

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

- Direct Lisp/FFI/Python/shell access is limited by the OS to runtime files,
  selected read-only input copies and compiled bundle, and the worker's scratch/cache.
- Project changes use host-validated proposals. New regular files can be created
  with necessary parent directories. Deletion and replacement require the human
  confirmation showing the exact target, digest and backup location.
- Refusal, skip, timeout, cancelled confirmation or unavailable UI means no change.
  File identities/content are checked again after approval. Links, directories,
  database files/sidecars, common credential paths and plugin/state data are refused.
- Backups are independent copies, never hard links. Their global reservation limit
  is 1 GiB in this implementation; reaching it stops changes without pruning data.
- The host journal distinguishes success, failure, no change, in progress and
  unknown outcomes. Unknown changes are never automatically replayed or rolled back.

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

macOS denies fork inside workers and jobs. Use `kioku.process` broker APIs for
external processes. Result helpers (`result-ok?`, `result-code`, `result-stdout`,
`result-stderr`, `run-lines`, `python-stdout`, `shell-stdout`) and generation-local
job helpers (`list-jobs`, `forget-job`) avoid ordinary shell plumbing.

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
arguments, URL, directory or shell input is not accepted. Before execution, the
native confirmation shows the command, repository root, timeout and possible
artifact effects. Refusal, cancellation or unavailable confirmation returns
`NOT_APPLIED`; nonzero exit returns `FAILED` with bounded output. The enclosing
`lisp_eval` operation ID provides replay and conflict handling.

Typical flow:

```lisp
(kioku.ci:list-runs :limit 5)
(kioku.ci:failed-log 123456789)
;; inspect project inputs, then propose a bounded file change
(kioku.files:propose-write "path/to/file" new-content)
(kioku.ci:verify :lisp)
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
