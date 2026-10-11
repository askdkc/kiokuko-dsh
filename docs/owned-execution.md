# Kiokuko-owned development execution

Kiokuko registers native `kioku_read`, `kioku_write`, `kioku_edit`,
`kioku_remove`, `kioku_exec`, and `kioku_result` tools. They use Node filesystem
and process services directly; stock DSH filesystem/shell sandbox settings do
not control this executor. Native presentation and PTC transport both remain
supported. Plan, goal, cancellation, admitted identity, and Enno delegation
scope still apply.

Ordinary project reads, edits, builds, tests, PATH commands and investigation
needed for development require no additional confirmation. Bash/zsh inherit
the user's environment and may start child processes. Source/data deletion and
existing durable user database mutation require confirmation of concrete
targets. Generated artifacts and temporary/disposable data do not. Declare
`destructiveTargets` for destructive commands: arbitrary shell/Lisp/FFI code
cannot be completely classified in advance. An unknown side effect does not
justify refusing execution or treating its result as verification.

## Tools and replay

- `kioku_read({path})` returns content and its SHA256.
- `kioku_write({path,content,expectedHash?})` and
  `kioku_edit({path,oldText,newText,expectedHash?})` compare the actual file with
  the requested result. An edit requires exactly one matching occurrence.
  `expectedHash:null` requires a new file; changed hashes reject a stale edit.
- `kioku_remove({path,expectedHash?})` removes a single file.
- `kioku_exec({command,cwd?,shell?,background?,timeoutMs?,destructiveTargets?})`
  executes in the canonical cwd, including project subdirectories.
- `kioku_result({operationId,cancel?})` retrieves or cancels the existing
  process. It never starts the command again. Collect background operations
  until their receipt is terminal.

Each tool returns a host-generated receipt with operation/run/session/generation
identity, actual cwd/command, file hashes, process exit/signal/cancellation/timeout,
and verification and persistence states. Process output is bounded at 32 MiB;
the host parses complete output before returning a 24,000-character preview.
Observed/displayed byte counts and an output digest distinguish the two scopes.
Environment variables and full command output are not persisted in execution receipts or passed as supervisor command-line arguments. Secret-bearing
commands and previews are redacted.

Operation identity is tied to the native call. Replaying it with another
run/generation or changed arguments conflicts. SQLite receipts and a private
local journal beside the configured database survive restart. A failed SQLite
save leaves `persistence:pending`; retrieving the result retries storage without
repeating edits/tests. If the outbox is unavailable, execution can use a database reservation; failure of both stores is reported as pending and cannot promise durable replay protection. A started receipt after a crash becomes unknown, and
its effect is never automatically retried. Loss of both durable stores cannot
be reconstructed from a model's success report. After restart, saved receipts restore terminal metadata and verification summaries; full output previews and read contents are not restored from the journal. Use a new read operation to inspect current file contents.

## Verification and memory

Register conditions and source/test/configuration paths with `task_completion`
before running the check. Memory application reviews may specify a repository-relative `cwd`; omitted values retain the historical repository-root meaning. Actual directory, command, source digest, run and generation must match. Owned shell and Lisp process calls feed the existing
completion and memory-application records. Exit zero alone does not establish
test success: complete Node TAP and Cargo harness summaries distinguish passed,
failed, cancelled, ignored/skipped, filtered and zero/incomplete test runs.
Include every relevant input in the registered source set.

Finalization receives structured observations and source-bound checks. Candidate
memories cite stored receipts from the same run/session and retain conditions
and source versions. Existing transactions, leases and effect deduplication own
memory saving; memory retries do not rerun development tools. A staged, secret-scanned extraction is reused after adoption fails only when its run, source log, evidence manifest and entry revisions still match. Retrieval exposes
execution provenance and recomputes source freshness. Historical results are
explicitly `currentTaskVerification:false`; they do not complete a new task.
Unrelated generated files and ordinary reads do not invalidate declared source checks. Unknown side effects mark affected verification unknown without rejecting execution. Tool responses return work, verification, receiptPersistence and memoryStorage separately; not_scheduled is not a successful memory save.

## Lisp and Plan

`lisp.executionMode` defaults to `development`, including when an old profile
omits it or has `approvalMode:ask`. Ordinary tools and Lisp coexist. Process RPC
and workspace proposals use the owned executor; helper toolsets still compile
and validate their schemas/examples. Worker failures leave ordinary tools
available. `executionMode:protected` explicitly selects the legacy isolated
worker/approval/fence behavior for compatibility; it is not the default.

Lisp source can directly call filesystem/FFI APIs in development mode. Such
effects are not independent process/test proof. Prefer `kioku.tools:call-tool`
and `kioku.process` for observed results. Plan blocks effectful owned/Lisp
operations. An explicit human implementation instruction or plan approval
requests Plan exit at the next accepted native boundary; merely presenting a
plan does not exit it.

## Local acceptance

```sh
npm run typecheck
KIOKUKO_REQUIRE_DSH_NATIVE=1 KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" node scripts/run-tests.mjs tests/dsh/integration/owned-native-lifecycle.test.ts
KIOKUKO_REQUIRE_CARGO_RUNTIME=1 node scripts/run-tests.mjs tests/dsh/integration/owned-execution.test.ts
KIOKUKO_REQUIRE_LISP_RUNTIME=1 KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" npm run test:lisp
npm run build
npm run test:skill-delivery
npm run test:modules
npm run pack:check
```

The runtime tests use disposable profiles/databases and scripted provider
responses. They establish local/native execution, persistence and retrieval;
they do not prove a live provider or the user's installed profile. The test
runner bounds concurrent Lisp compilation to two files. Set
`KIOKUKO_TEST_CONCURRENCY` (1–64) to override it.
