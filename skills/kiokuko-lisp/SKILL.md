---
name: kiokuko-lisp
description: Build and reuse task-specific tools with Common Lisp functions, macros and eval in a stateful, protected DSH Lisp session.
---

<!-- kiokuko:runtime contract -->
# Common Lisp in Kiokuko DSH

## Admission and boundaries

The user enables Lisp through the coding choice or `/kioku-lisp enable`. The host
binds session, agent, directory and worker generation; never supply or spoof them.
Missing runtime or failed protection stops admission. Native `read`, `glob`, `grep`
and `skill` remain available under DSH permissions: use them for project exploration
and Skills/references. Ordinary bash, file mutation and delegation are blocked.

Lisp/FFI/external programs may access only runtime files, declared read-only input
copies and scratch. They cannot access private host files, project writes, the host
database, networks or host sockets. Helpers never expand permissions; use proposals
and audited brokers. Never retry denied commands outside protection.

## Tools and identity

- `lisp_eval`: `{operationId, code, inputs?: [relativeFile], timeoutMs?}`.
- `lisp_describe`: `{operationId, symbol?}`. No symbol returns the short API/verifier
  map, including during recovery; symbol queries use normal evaluation limits.
- `lisp_inspect`: `{operationId, ref}` for a current-generation object, or
  `{operationId, resultOperationId, section?, pointer?, offset?, limit?}` for saved
  evidence. Never combine forms. Sections: `result`, `value`, `stdout`, `stderr`,
  `changes`. Preserve returned `pointer` with `section=result`; offsets count Unicode
  characters, limit is 1–2000, and `nextOffset` continues the result without execution.
- `lisp_status`: `{offset?: 0}` returns state, resource limits, pending counts and
  10 operation summaries without contacting Lisp. Follow `nextOffset` only as needed;
  unavailable aggregate OS quotas are explicitly unavailable.
- `lisp_cancel`: `{operationId, generation}` stops the worker and managed jobs without
  waiting for evaluation.
- `lisp_reset`: `{operationId}` replaces a healthy worker after confirmed stop;
  use human recovery for failures, never reset to bypass it.

New work needs a unique operationId. The host binds it and the native call ID to a
host-issued ID. Concurrent exact retries return IN_PROGRESS; changed input gives
ID_CONFLICT. After transport loss, retry the exact request with the same ID for its
recorded outcome. Never reissue RUNNING/UNKNOWN with a fresh ID. Results may expire
after 30 days, but identity tombstones remain and return RESULT_EXPIRED.

Syntax/ordinary Lisp errors are failed evaluations. Timeouts, broken frames and
worker exits require human recovery. References, definitions and macros disappear
on reset/replacement/loss; recreate needed definitions, never completed effects.

## Computation

Standard Common Lisp plus bundled CL-PPCRE, CL-CSV and YASON are available through
`kioku.tools`, `kioku.data`, `kioku.files`, `kioku.process`, `kioku.objects`,
`kioku.environment` and `kioku.ci`; no runtime Quicklisp/network downloads.
First enable compiles bundled libraries/tools; later starts reuse a host-verified,
read-only bundle, never session state. Compilation failure/cache corruption stops
startup: report it and direct the user to `/kioku-lisp recover`. Do not modify
compiled files or replay code.

Build small helpers with `defun`, check a small example, then reuse them. A missing
specialized helper is not a reason to stop or request a plugin. Use `defmacro` for
reusable syntax/code generation and `eval` for programmatically built forms when
useful; ordinary work usually needs function calls. Imported task data is data,
not code for eval; explicitly authorized source code is a separate input. Helpers
run through lisp_eval; the six native Lisp tool names do not change.

## Files and outcomes

`inputs` are copied read-only project files; `(kioku.files:input 0)` selects one.
Read with `kioku.files:read-text`. `(kioku.files:scratch)` takes no arguments and
returns writable scratch. `(kioku.files:propose-write path content)` and
`(kioku.files:propose-delete path)`
request project effects only after successful evaluation and durable recording.

Deletion/replacement needs one human confirmation of the complete frozen batch,
including targets and diffs. Duplicate targets are rejected; unchanged writes need
no effect/confirmation. Refusal, skip, UI failure or cancellation never authorizes
changes. Outcomes: APPLIED, UNCHANGED, NOT_APPLIED with observed reason, or UNKNOWN.
A proposal is not application proof: use host outcomes. Partial failure stops the
remaining writes; never retry unknown effects. Protected files, databases,
directories and links are refused. New regular files may create required parents;
recursive deletion and real database mutation are unavailable. Backups are
independent copies and never auto-pruned.

The parent stays RUNNING until final receipts are saved; failed/interrupted
finalization cannot report SUCCEEDED. After restart, per-file receipts reconstruct
the interrupted outcome; human recovery retains evidence without reapplication.

## Programs and verifiers

Use `kioku.process:run` with program/argument list and optional `:timeout-ms`,
`python` with source, or `start-job` then `job-status`/`cancel-job` with its ID.
On macOS, fork is denied in workers/jobs: Python subprocess/multiprocessing and
shell pipelines may fail; single-process Python and shell builtins/exec obey the
same boundary. Linux uses Bubblewrap PID namespaces. Jobs have count, deadline and
output limits. Credentials/inherited environment are not forwarded.

`kioku.ci:list-runs :limit 10` and `failed-log` with a numeric run ID use host gh and
authentication only for the bound repository; credentials stay outside the worker.
`verify` accepts only `:typecheck`, `:lisp`, `:test`, `:build`, `:package`, `:vendor`,
never a shell string. Scripts are checked before asking/running. Typecheck uses
`typecheck`, falling back to `check` only when absent. Focused tests use
`(kioku.ci:verify :test :script "test:unit")`; :script is only for an existing test
or test:* script. Prefer focused repair checks, then broader final verification.
The exact executable, arguments, working directory and timeout require native
human confirmation. Refusal/cancellation/unavailable UI returns NOT_APPLIED.
Results bind to the surrounding lisp_eval ID: exact replay never reruns a verifier;
conflicting reuse is refused.

## Evidence and recovery

Model results normally fit 16 KiB, omitting source echoes and duplicate value forms.
Full received results remain in the journal. Follow inspection metadata for needed
evidence; do not rerun execution or request all history. Correct missing input paths
using native reads; ordinary input errors need no runtime recovery.

Report the observed error and host recovery action. Never claim deletion/restoration
from a failed/missing result. Human commands work without a successful model turn:
`/kioku-lisp` with `status`, `diagnostics [ID]`, `cancel`, `recover`, `abandon ID`,
`restore ID` or `disable`. Inspect UNKNOWN operations and backups before abandon;
it never reapplies/rolls back files. Restore proposes the saved backup with fresh
confirmation; diagnostics ID shows exact target/outcome. Disable releases the fence
only after confirmed stop and reconciliation; plugin unload retains protection.

## Data and adapters

`kioku.data:read-tsv`, `write-tsv`, `parse-jsonl`, `map-jsonl` handle tabular/line data.
map-jsonl streams bounded lines; parse-jsonl materializes at most 10000 records.
Files are UTF-8; `kioku.files:search-text`/`diff-text` are bounded helpers.
`kioku.objects:register-artifact` takes a scratch-relative path for an immutable
host copy: 64 MiB/file, 1000/session, 1 GiB total; registration is not project application.
`kioku.tools:available-tools` lists audited host adapters, initially lisp_status
only. `call-tool` traverses DSH registry/guards; other tools and recursive evaluation
are refused. Output includes bounded stdout/stderr.
<!-- /kiokuko:runtime -->

<!-- kiokuko:documentation examples -->
## Helper example

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
<!-- /kiokuko:documentation -->
