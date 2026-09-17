---
name: kiokuko-lisp
description: Build and reuse task-specific tools with Common Lisp functions, macros and eval in a stateful, protected DSH Lisp session.
---

<!-- kiokuko:runtime contract -->
# Common Lisp in Kiokuko DSH

The user starts this mode by choosing Lisp before coding or with
`/kioku-lisp enable`. The host binds the current
session, agent, directory and worker generation. Never supply or spoof those
identities. Ordinary bash, file tools and delegated execution are blocked while
this mode is active. A missing runtime or failed protection check stops admission.

## Six tools

- `lisp_eval`: `{operationId, code, inputs?: [relativeFile], timeoutMs?}`.
- `lisp_describe`: `{operationId, symbol?: "kioku.files:propose-delete"}`.
- `lisp_inspect`: `{operationId, ref}` for a retained value in this generation.
- `lisp_status`: `{}` reads host state, including during failures.
- `lisp_cancel`: `{operationId, generation}` stops the worker and its managed jobs.
- `lisp_reset`: `{operationId}` replaces a healthy worker after confirming stop.

Use a unique operationId for new work. The host binds it and the native call ID to
a durable host-issued operation ID. Same-request concurrent retries return
IN_PROGRESS; changed input returns ID_CONFLICT. Results retained for 30 days can
expire, but their identity remains a tombstone and returns RESULT_EXPIRED. Retry the exact same request with the same
ID after transport loss: the host returns its recorded outcome. RUNNING/UNKNOWN
must never be reissued with a fresh ID to bypass deduplication. Syntax/ordinary
Lisp errors return a failed result; timeouts, broken frames and worker exits
require human recovery. References and definitions disappear on reset.

## Computation and data

```lisp
(defparameter *rows* (kioku.data:read-csv "name,score
A,3
B,5"))
(kioku.data:regex-matches "[0-9]+" "a12b34")
(gethash "x" (kioku.data:parse-json "{\"x\":42}"))
(kioku.objects:retain *rows*)
(kioku.tools:describe-tools)
```

Packages: `kioku.tools`, `kioku.data`, `kioku.files`, `kioku.process`,
`kioku.objects`, `kioku.environment`, `kioku.ci`. CL-PPCRE, CL-CSV and YASON are bundled;
there is no runtime Quicklisp/network download. Standard Common Lisp is available.
First enable automatically compiles the bundled libraries and tools. Later starts
reuse a host-verified, read-only bundle; session state is never cached. Compilation
failure or cache corruption stops startup. Report the error and direct the user
to `/kioku-lisp recover`; do not attempt to modify compiled files or replay code.

## Build the tools you need

In Lisp mode, you can create the tools needed for the user's task as you work.
When no ready-made helper fits, define a small function with `defun` through
`lisp_eval`, check it on a small example, then reuse it in later evaluations.
Compose standard Common Lisp and the available `kioku.*` APIs into parsers,
transformations, validators, reports or task-specific workflows. A missing
dedicated tool name alone is not a reason to stop or request another plugin.

Use `defmacro` when reusable syntax or code generation helps, and `eval` when
you need to evaluate a programmatically constructed form. Ordinary computations
usually need only function calls. Treat imported task data as data, not as code
for `eval`; user-authorized source code is a separate input.

For example, define a tool-generating macro in one `lisp_eval` call:

```lisp
(defmacro define-threshold-counter (name threshold)
  (let ((items (gensym "ITEMS")) (item (gensym "ITEM")))
    `(defun ,name (,items)
       (count-if (lambda (,item) (> ,item ,threshold)) ,items))))
(define-threshold-counter count-over-10 10)
(count-over-10 '(3 12 19)) ; => 2
```

In a later call on the same worker, reuse it or generate another tool:

```lisp
(eval (list 'define-threshold-counter 'count-over-20 20))
(list (count-over-10 '(3 12 19)) (count-over-20 '(3 12 29))) ; => (2 1)
```

These tools are Lisp definitions called through `lisp_eval`; the six native DSH
tool names stay fixed. Definitions and macros persist only in the current worker
generation and disappear when it is replaced, reset or lost. Recreate needed
definitions after recovery without replaying completed side effects. Creating a
helper does not expand file, network, subprocess or host-adapter permissions;
use the existing proposal and broker APIs for those effects.

## Files

Pass required project files as `inputs`; `kioku.files:input` returns their copied,
read-only worker paths. The worker may directly read/write its scratch directory.
It cannot read private host files, write project files, access the host database
or connect to networks/host sockets, even through FFI or external programs.

```lisp
(kioku.files:read-text (kioku.files:input 0))
(kioku.files:propose-write "report.txt" "result")
(kioku.files:propose-delete "obsolete.txt")
```

Proposals are applied only after successful evaluation and durable recording.
Deletion and replacement of existing files require the native human confirmation
for the exact frozen target/content. Refusal, skipping, UI failure and cancellation
never grant permission. A proposal is not proof that a change occurred: inspect
its host outcome. Protected files, database files, directories and links are
refused. New files may create necessary parent directories; recursive deletion is unavailable. No real database mutation
API is provided. Backups are independent host copies and are never auto-pruned.

## External programs and jobs

```lisp
(kioku.process:python "print(sum(range(10)))")
(kioku.process:run "python3" '("-I" "-c" "print(42)") :timeout-ms 10000)
(defparameter *job* (kioku.process:start-job "python3" '("-I" "-c" "print(42)")))
(kioku.process:job-status *job*)
(kioku.process:cancel-job *job*)
```

Use these broker APIs for subprocesses. On macOS, OS protection denies fork in
workers and jobs: Python subprocess/multiprocessing and shell pipelines may fail.
Single-process Python and shell builtins/exec work within the same file/network
boundary. On Linux, Bubblewrap uses a PID namespace. Do not retry blocked commands
outside the protection boundary. Jobs have a maximum count, deadline and output
limit. Credentials and inherited environment variables are not passed through.

## GitHub CI and verification

```lisp
(kioku.ci:list-runs :limit 10)
(kioku.ci:failed-log 123456789)
(kioku.ci:verify :typecheck)
```

CI reads use the host's `gh` installation and authentication in the repository
bound to this session; credentials are never copied into the worker. Run IDs are
numeric and resolved only against that repository. Verification accepts only
`typecheck`, `lisp`, `test`, `build`, `package`, or `vendor`; it never accepts a
shell string. The exact executable, arguments, working directory and timeout are
shown for native human confirmation. Refusal, cancellation and unavailable UI
return `NOT_APPLIED`. Results are bound to the surrounding `lisp_eval` operation
ID, so exact replay does not run a verifier twice and conflicting reuse is refused.

## Stop and recover

Always explain the observed error and the host-reported recovery action. Do not
claim successful deletion or restoration from a failed or missing response.
The user can run `/kioku-lisp status`, `/kioku-lisp diagnostics`,
`/kioku-lisp cancel` or `/kioku-lisp recover` without a successful model turn.
UNKNOWN file operations must be inspected with their backups before human
`/kioku-lisp abandon ID`; abandonment never reapplies or rolls back files.
`/kioku-lisp restore ID` proposes restoring a saved backup with a fresh human
confirmation. `/kioku-lisp diagnostics ID` shows its exact target and outcome.
`/kioku-lisp disable` releases protection only after stop and reconciliation.
Plugin unload keeps the session fence in place until safe deactivation.

## Streaming, artifacts and host adapters

`kioku.data:read-tsv`, `write-tsv`, `parse-jsonl` and `map-jsonl` process tabular
and line-delimited data. `map-jsonl` consumes a stream with a bounded line length;
`parse-jsonl` caps materialized records at 10000. Files use UTF-8.
`kioku.files:search-text` and `diff-text` provide bounded text helpers.
`kioku.objects:register-artifact` takes a scratch-relative file and registers an
immutable host copy (maximum 64 MiB/file, 1000/session, 1 GiB total). Registration
does not apply a file to the project.

`kioku.tools:available-tools` lists audited host adapters. Initially only
`lisp_status` is exposed; `call-tool` passes through DSH's registry and guards.
Other tools, including recursive evaluation, are refused.

`lisp_describe` without a symbol reads bundled guidance even during recovery.
A symbol query and inspection execute under the normal evaluation limits.
`lisp_status` reports job state and resource limits; unavailable aggregate OS
quotas are explicitly marked unavailable. Output includes bounded stdout/stderr.
<!-- /kiokuko:runtime -->
