For configured semantic routing, use [provider-independent decisions](typed-decisions.md) and `kioku.decisions`. Lisp coexists with normal tools; routine development is authorized and destructive changes retain concrete review.

# Common Lisp tools

For approved named functions shared across task-mode sessions, see
[Project-shared Lisp functions](lisp-hot-tools.md). Active code survives worker
and host restarts; input and result refs remain private to their owner.

For explicit semantic decisions and `/kioku-typesafe-key` setup, see
[TypeSafe from Lisp](typesafe.md). Answers can guide inspection and proposals;
the existing permission and approval boundaries still apply.

The default is `lisp.executionMode: development`. Old `approvalMode` values remain readable. Set `executionMode: protected` explicitly to select the legacy worker/approval/fence behavior. See [owned execution and memory evidence](owned-execution.md).

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

Enter a normal implementation or debugging request in DSH, including dsh-cli.
With `typedDecisions.mode: auto`, an accepted Jev/Laya `build` or `debug`
classification reaches the existing Lisp question without repeating the task-category
question. Laya receives complete requests up to 4096 UTF-8 bytes, including quoted
filenames, multiple sentences, combined actions and negations. The selected model
chooses the type; it does not grant permission or drop other requested actions.
Missing context, explicitly undecided alternatives, envelope/provider capacity
rejection and model abstention defer classification. Native adapters let the
ordinary model infer advisory intent or ask a concrete clarification; they do not
repeat the generic category dialog merely because the classifier abstained. The host asks whether to use Lisp
before coding begins; it resolves unclear task intent first. Both enable and decline choices
persist for that session, including after a restart. Conversation and review
requests do not trigger this prompt. Free text returns to conversation without
starting Lisp; cancellation preserves pending work; startup failure leaves ordinary coding available.

Choosing Lisp also selects normal execution; Enno requires choosing not to use
Lisp. The prompt is available only when `lisp.enabled` is true. To enable Lisp
manually or inspect its state, use these commands in the desired DSH session:

```text
/kioku-lisp enable
/kioku-lisp status
```

This enables the Lisp tools and supplies the bundled `kiokuko-lisp` Skill.
Existing DSH `read`, `glob`, `grep` and `skill` tools remain available under native
session permissions, so project files and applicable Skills can be inspected.
File changes can use owned native tools or Lisp proposals. Ordinary writes/edits do not request approval; destructive source/data deletion retains a concrete review. Lisp startup/recovery failures do not block ordinary tools.
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
- Lisp/FFI/Python/shell use the normal user environment. Prefer owned tools and broker APIs for host-observed execution; direct arbitrary effects are not verification evidence.
- Project proposals freeze targets, preserve backups and reject duplicate targets. Writes/edits are authorized; source/data deletion requires concrete confirmation. Generated/temp/disposable artifacts are routine development.
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

The host serializes conflicting target proposals and checks their captured hashes before applying them. This is not a transaction against arbitrary Lisp or unrelated programs; concurrent external changes can still race filesystem calls. Unknown outcomes require inspection and must not be replayed.

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

Lisp workers and processes use the normal user environment and process groups for termination. kioku.process run/start-job use the owned execution service; directory defaults to the admitted workspace and may select a real subdirectory. Collect background results rather than rerunning commands.
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
with `:location :scratch`. Absolute paths, traversal and links are refused. Routine verifier execution needs no approval. The host records actual cwd, process outcome and full-output test summaries before display shortening. Register completion checks and source paths before execution. Nonzero exit is FAILED; zero exit alone is not test coverage. The enclosing
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

Native `ask_user_question` and `exit_plan_mode` remain available in both Lisp modes. Plan approval uses the DSH review UI. Explicit human implementation instructions also request exit at the next accepted boundary. Protected compatibility mode retains its Lisp sandbox; development mode allows ordinary owned tools after Plan exits. Run `npm run test:lisp:plan:web` for a disposable packed-package Web check without model credentials.

<!-- kiokuko:runtime approval-policy -->
## Development approval policy

The legacy lisp.approvalMode ask/auto configuration and profile commands remain readable. Both authorize routine project edits, tests, helper registration and Kioku saving. Neither disables concrete confirmation for source/data deletion or durable user database mutation. A worker failure leaves normal tools available. Refusal, cancellation, changed targets and unknown outcomes cannot authorize effects.

Use kioku_read/write/edit/remove/exec/result for observed work. Host receipts distinguish actual process outcome, source-bound verification and saving status. Lisp/model passed fields are advisory. Saving can be retried without repeating development effects; after restart an interrupted process remains unknown. See [owned execution](owned-execution.md).
<!-- /kiokuko:runtime -->

Pinned DSH stores this setting in the native `kiokuko-lisp` namespace, keyed by
the host-owned profile identity. Current DSH exposes `lisp.approvalMode` through
the native `kiokuko-dsh` configuration form and saves its profile patch. This
compatibility difference does not change the controls or scope. No separate
preference file or database migration is used.


## Read-only code intelligence

Persistent `lisp_eval` can use an optional `CodeIntelligenceServiceV1` from
`@askdkc/dsh-lsp-server`. Kiokuko resolves it in the calling agent's context.
The provider owns Tree-sitter, grammars, source snapshots, coordinates, and LSP
processes. Kiokuko does not install them or fall back to generic LSP tools.
Core alone has no code-intelligence runtime dependency.

The published provider v0.1.12 does not supply V1. The local prerequisite is kept
as a reproducible [upstream patch](../patches/code-intelligence/README.md). A
future compatible provider should advertise V1 and the required capabilities;
package version alone is insufficient. Absence, an old provider, missing grammar,
and an unready language server return explicit outcomes. They do not block the
ordinary Lisp APIs. Node must satisfy Kiokuko's `>=24.16.0` requirement.

Start with `(kioku.code:capabilities)`. Its response includes `status`, `reason`
when relevant, `data.version`, `data.capabilities`, `data.languages`, distributed
`data.queryIds`, and `data.semanticReady`. The last field stays false until this lease completes a semantic query: a
server executable's presence does not establish a synchronized semantic result.

```lisp
;; One evaluation: aggregate locally, return selected source and metadata.
(kioku.code:with-snapshot (snapshot "src/example.ts")
  (let ((outline (kioku.code:outline snapshot :limit 20)))
    (if (member (gethash "status" outline) '("ok" "partial") :test #'equal)
        (let ((items (gethash "items" (gethash "data" outline))))
          (kioku.internal:object
            "status" (gethash "status" outline)
            "omitted" (gethash "omitted" outline)
            "declarationCount" (length items)
            "selected" (if (plusp (length items))
                           (kioku.code:span (gethash "handle" (aref items 0))
                                            :max-chars 1000)
                           #())))
        outline)))
```

Check `status` before accessing `data`. `ok` with an empty array means the query
completed with no results. `partial` preserves parse-error/truncation information.
`unsupported`, `unavailable`, `stale`, `cancelled`, `timeout`, and `limit_exceeded`
are separate states. Missing diagnostics publication never becomes a clean file.
`with-snapshot` returns the opening failure unchanged and always releases an
accepted snapshot, including on a Lisp error. For other queries, branch explicitly
on `ok`/`partial` before using their `data`.

| Lisp function | Arguments | Purpose |
| --- | --- | --- |
| `capabilities` | none | Negotiate V1, per-language readiness, disk sources and limits |
| `open` | path | Pin a bounded disk source snapshot |
| `outline` | handle, `:range`, `:limit` | Bounded declaration map |
| `enclosing` | handle, position, `:kinds` | Nearest matching node and ancestors |
| `query` | handle, query ID, `:range`, `:limit` | Distributed `declarations`, `calls`, `imports` captures |
| `span` | node handle, `:max-chars` | Bounded original source span |
| `semantic` | handle, kind, `:position`, `:limit` | `definition`, `references`, `implementation`, `hover`, `diagnostics`, `completion` |
| `release` | handle | Idempotent release |

Positions are JSON objects such as `(kioku.internal:object "line" 1 "character" 2)`:
zero-based lines and UTF-16 character offsets. Ranges have `start` and `end` and
are half-open. The provider performs conversion. There is no unsaved-editor
synchronization claim: `sourceKind` is `disk`, with freshness and a snapshot version
on every accepted source result. File/checkout changes require an explicit reopen.
Handles and node handles expire at evaluation end; journal replay and saved
`lisp_inspect` output are historical evidence, never live capabilities. Task workers
retain their host-RPC prohibition. Neither `lsp` nor `lsp_extra` is added to the
protected tool allowlist; child sessions cannot borrow admission.

Each evaluation has 100 charged calls (including capabilities and failed attempts),
100 files, 16 MiB cumulative source input, 64 KiB cumulative code responses, and a
30-second code budget. Individual documents are at most 2 MiB; captures 200,
outline entries 100, source spans 8,000 UTF-16 units, responses 32 KiB. Structural
calls have a 2-second deadline and semantic calls 10 seconds, capped by the batch
and caller deadlines. Release/disposal remain available outside exhausted budgets.
Model presentation remains capped at 16 KiB and retains code outcome metadata;
use bounded `lisp_inspect` pages for saved detail. Aggregate counts and chosen spans
inside Lisp; returning full outlines can increase output instead of reducing it.

The local prerequisite currently supports JavaScript/JSX/TypeScript/TSX. Its
checkout metadata read must be allowed by the scoped host filesystem. Linked Git
worktrees whose metadata is outside that scope return
`unavailable` rather than read through another filesystem. This condition is
reported independently from grammar and language-server readiness.

Development verification is `npm run test:code-intelligence` after preparing the
provider fixture. The source/native and packed paths are separate checks. The CI
matrix runs normal development on macOS, Ubuntu 26.04, and Arch; the protected code-provider path
is exercised on macOS; Linux protection remains a separate native-suite check. A configured job
is not evidence that the remote job passed.

Clean installation and platform status: [code intelligence setup](code-intelligence.md).
