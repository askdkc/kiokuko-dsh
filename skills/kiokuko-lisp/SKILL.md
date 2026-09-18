---
name: kiokuko-lisp
description: Compose reusable task tools with Common Lisp functions in a persistent, protected DSH session.
---

<!-- kiokuko:runtime contract -->
# Common Lisp in Kiokuko DSH

## Admission and boundaries

Enable via the user's coding choice or `/kioku-lisp enable`. Host-bound session,
agent, directory and generation must never be supplied/spoofed. Missing runtime or
failed protection stops admission. Native `read`/`glob`/`grep`/`skill` retain DSH
permissions for exploration/Skills. Ordinary bash, mutation and delegation are blocked.

Lisp/FFI/programs access only runtime files, declared read-only copies and scratch:
no private host files, project writes, database, network or host sockets. Helpers
cannot expand permissions; use proposals/audited brokers, never retry outside protection.

## Tools and identity

- `lisp_eval`: `{operationId, code, inputs?: [relativeFileOrAttachmentPath], timeoutMs?}`.
- `lisp_describe`: `{operationId, symbol?}`. Omit symbol for the API/verifier map
  (also during recovery); package names list exports, functions give arguments/docs.
  Normal query limits apply.
- `lisp_inspect`: `{operationId, ref}` for a current-generation object, or
  `{operationId, resultOperationId, section?, pointer?, offset?, limit?}` for saved
  evidence; never combine forms. Sections: `result`, `value`, `stdout`, `stderr`,
  `changes`. Keep `pointer` with `section=result`; Unicode offsets, limit 1–2000.
  `nextOffset` pages without execution.
- `lisp_status`: `{offset?: 0}` reads state/limits/pending counts and 10 operation
  summaries without Lisp. Page via `nextOffset` as needed; absent OS quotas remain unknown.
- `lisp_cancel`: `{operationId, generation}` stops the worker and managed jobs without
  waiting for evaluation.
- `lisp_reset`: `{operationId}` replaces a healthy worker after confirmed stop;
  use human recovery for failures, never reset to bypass it.

New work needs a unique operationId, bound with the native call ID to a host ID.
Concurrent exact retries give IN_PROGRESS; changed input gives ID_CONFLICT. After
transport loss, retry the identical request/ID for its recorded outcome. Never give
RUNNING/UNKNOWN a fresh ID. After 30 days results may expire; identity tombstones
remain and return RESULT_EXPIRED.

Syntax/ordinary Lisp errors are failed evaluations. Timeouts, broken frames and
worker exits require human recovery. References, definitions and macros disappear
on reset/replacement/loss; recreate needed definitions, never completed effects.

## Build task tools

Common Lisp, CL-PPCRE, CL-CSV and YASON are available through
`kioku.tools`, `kioku.data`, `kioku.files`, `kioku.process`, `kioku.objects`,
`kioku.environment` and `kioku.ci`; no runtime Quicklisp/network downloads.
First enable compiles; later starts reuse verified read-only code, never session
state. Compile/cache failure stops startup: report `/kioku-lisp recover`; never
modify compiled files or replay code.

Before repeated primitive calls, define named `defun` tools for the needed outputs
and compose them (e.g. `repair-and-check`). Define/test/use in one lisp_eval;
reuse with new inputs on later calls.
Batch known reads/transforms/checks in Lisp; return compact results/failure evidence.
Split at new decisions, approvals or resource limits.
Keep helpers cohesive; do not preprogram guesses. Use `defmacro` for needed syntax;
imported data is never eval code. Definitions persist per generation;
`lisp_describe` with `kioku.user` lists them, exact names give arguments/docs.
lisp_eval carries composed calls; six native tools stay fixed.

## Files and outcomes

`inputs`: workspace-relative files or exact paths of this session's user uploads.
DSH verifies attachment identity/size/digest and copies read-only; other absolute
paths are refused. Limits: 64 MiB/file, 256 MiB/generation. Use upload paths directly;
`(kioku.files:input 0)` is the first copy. `(kioku.files:scratch)` takes no args;
use `read-text`/`write-text` there.
Unpack archives with brokered `unzip` into scratch; copy/edit with Lisp helpers.
Workspace reads also need `inputs`. Reimport applied files for full comparisons.
Stay in the authorized directory; export only when authorized.
`propose-write`/`propose-delete` require workspace-relative strings/pathnames,
successful evaluation and durable recording:
`(kioku.files:propose-write "src/infer.mjs" (kioku.files:read-text src))`.

Deletion/replacement needs human confirmation of the frozen batch's targets/diffs.
Duplicate targets are refused; unchanged writes need no effect/confirmation.
Refusal, skip, UI failure/cancellation never authorizes. Trust host outcomes, not
proposals: APPLIED, UNCHANGED, NOT_APPLIED (reason), UNKNOWN. Partial failure stops
remaining writes; never retry unknown effects. Protected files/databases/directories/
links are refused. New files may create parents; no recursive deletion or database
mutation. Backups are independent and never auto-pruned.

RUNNING lasts until receipts are saved; failed/interrupted finalization cannot
report SUCCEEDED. Restart reconstructs outcomes from receipts; recovery never reapplies effects.

## Programs and verifiers

`kioku.process:run`/`start-job` take program, argument list, `:timeout-ms` and
`:directory` (scratch-relative, default `"."`; no links/traversal). `python` takes
source; jobs use `job-status`/`cancel-job`. The macOS sandbox denies fork: use Lisp
file helpers/direct broker calls, not shell chains, npm or multiprocessing.
Node uses empty OpenSSL config; `--test --experimental-test-isolation=none` (22.8+)
avoids children; this is not `npm test`. Linux uses Bubblewrap PID
namespaces. Jobs have count/time/output limits; no credentials/inherited environment.

`kioku.ci:list-runs :limit 10`/`failed-log` (numeric run ID) use host gh/auth only for
the bound repository; credentials never enter the worker.
`verify` accepts only `:typecheck`, `:lisp`, `:test`, `:build`, `:package`, `:vendor`,
never a shell string. Scripts are checked before asking/running. Typecheck uses
`typecheck`, falling back to `check` only when absent. Focused tests use
`(kioku.ci:verify :test :script "test:unit")`; :script is only for an existing test
or test:* script. Prefer focused repair checks, then broader final verification.
`:directory "project"` selects a workspace subproject; extracted projects use
`(kioku.ci:verify :test :location :scratch :directory "extract/project")`.
Approved npm/lifecycle scripts run on the host outside worker protection without
workspace copying. Roots are host-bound; absolute paths,
traversal and links are refused. Defaults/availability describe only the workspace root.
Native confirmation covers executable/args/cwd/timeout; refusal/cancellation/missing
UI gives NOT_APPLIED. The lisp_eval ID binds results: exact replay never reruns;
conflicting reuse is refused.

`ok=true` is evaluation success: check process `result-code` and verifier `state`/`code`.
Never claim unrun commands passed or partial reads prove byte equality. Distinguish
scratch/applied-file tests. Validate custom checkers on known cases before expanding.

## Evidence and recovery

Idle workers suspend after five minutes/slot pressure, never during active turns,
evaluations, approvals or jobs. Next use auto-starts; status does not. Rebuild lost
definitions/references, never effects. `WORKER_RESUMED` executed no code; abnormal
stops need recovery.

Results normally fit 16 KiB without source echoes/duplicate values; full received
results stay journaled. Follow inspection metadata; never rerun for output or fetch
all history. Correct missing paths with native reads; input errors need no recovery.

Report observed errors and host recovery actions; failed/missing results never prove
deletion/restoration. Human `/kioku-lisp` commands work independently: `status`,
`diagnostics [ID]`, `cancel`, `recover`, `abandon ID`, `restore ID`, `disable`.
Inspect UNKNOWN operations/backups before abandon (no reapply/rollback). Restore
needs fresh confirmation; diagnostics shows target/outcome. Disable requires
confirmed stop/reconciliation; unload retains protection.

## Data and adapters

`kioku.data:read-tsv`/`write-tsv` handle tables; `map-jsonl` streams bounded lines,
`parse-jsonl` caps records at 10000. Files are UTF-8; `kioku.files:search-text`/
`diff-text` are bounded.
`kioku.objects:register-artifact` takes a scratch-relative path for an immutable
host copy: 64 MiB/file, 1000/session, 1 GiB total; registration is not project application.
`kioku.tools:available-tools` lists audited adapters (initially lisp_status only).
`call-tool` traverses DSH guards/registry; other tools and recursive evaluation are
refused. stdout/stderr are bounded.
<!-- /kiokuko:runtime -->

<!-- kiokuko:documentation examples -->
## Task toolkit example

Adapt functions to the task's actual files and checks. Define this toolkit once
in one `lisp_eval`; later calls invoke `repair-and-check` with changed arguments.
The example checks a scratch Node project; it does not claim to run `npm test`.

```lisp
(defun replace-once (text before after)
  "Replace exactly one nonempty literal; reject absent or ambiguous matches."
  (when (zerop (length before)) (error "EMPTY_MATCH"))
  (let ((at (search before text)))
    (unless at (error "MATCH_MISSING"))
    (when (search before text :start2 (1+ at)) (error "MATCH_AMBIGUOUS"))
    (concatenate 'string (subseq text 0 at) after
                 (subseq text (+ at (length before))))))

(defun check-project (directory)
  "Return the scratch project's process exit code, stdout and stderr."
  (kioku.process:run "node"
    '("--test" "--experimental-test-isolation=none" "test/public.test.mjs")
    :directory directory))

(defun repair-and-check (directory file before after)
  "Edit one matched scratch file and check it; failed tests leave the edit visible."
  (let ((paths (kioku.files:glob-scratch
                (concatenate 'string directory "/" file) :limit 2)))
    (unless (= 1 (length paths)) (error "EXPECTED_ONE_FILE"))
    (let* ((path (aref paths 0))
           (source (kioku.files:read-text path))
           (updated (replace-once source before after)))
      (kioku.files:write-text path updated)
      (let ((result (check-project directory)))
        (setf (gethash "changedFile" result) path)
        result))))
```

Call it with a new operation ID (definitions and the first call may share one eval):

```lisp
(repair-and-check "project" "src/index.mjs"
                  "export const value = 0;" "export const value = 42;")
```

Inspect `code`/`stdout`/`stderr` in the returned object. Reuse `check-project` for a
baseline, `replace-once` for a pure transformation, or compose another task tool
from them. `lisp_describe` with `kioku.user` lists task functions and
`kioku.user::repair-and-check` returns its arguments and documentation. Discovery
never calls the function. Workspace application remains a separate proposal with
host outcomes and required approval; scratch tests do not prove applied-file tests.
<!-- /kiokuko:documentation -->
