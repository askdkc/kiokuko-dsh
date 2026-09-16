# Lisp verification — 2026-09-16

## Evidence and platform scope

| Layer | Result |
| --- | --- |
| macOS 27 / arm64, SBCL 2.6.8 | Real Seatbelt worker and brokered Python passed |
| Linux 6.18.15 / arm64, SBCL 2.2.9, Bubblewrap 0.8.0, Node 24.21.0 | Real worker, Python, network filter and native DSH guard passed |
| macOS / x64, Linux / x64 | CI jobs added; not executed in this local environment |
| TypeScript and build | Passed |
| Standard suite | 735 tests: 647 passed, 88 optional/environment tests skipped, no failures |
| Focused Lisp suite on macOS | 12 real/runtime and unit tests passed without skips; additional Unicode result test passed |
| Native DSH human-question service | Exact live-agent binding and refusal passed after Web-discovered correction |
| Vendor/package | 392 Git-tracked vendored files verified in a clean-source copy; tarball contents, import closure, client artifact and publint passed (see correction below) |
| Installed Web package | Isolated tarball install, fresh Lisp cache, explicit enable, restart recovery, native deletion refusal/approval, timeout guidance, explicit recovery, stop, backup restoration and safe disable verified |

The pinned native fixture and installed Web host use DSH **0.1.5-rc.1** (CLI,
`dsh-tools`, `dsh-user-questions` and Web app).

Linux was tested using an already-installed development container engine with a
temporary Linux guest. That engine is not referenced by the plugin runtime and is
not a product prerequisite. The guest was removed after testing. No SBCL binary
is included in the npm package. The existing macOS SBCL 2.6.4 failed a minimal
unprotected calculation; a disposable 2.6.8 test copy was used instead. The user's
SBCL and normal DSH profiles were not replaced.

Native Intel macOS and Linux x64 execution were not exercised locally. The CI
matrix is the remaining platform-verification path; its presence is not a passing
CI run.

## CI regression correction for da85bfc

[CI run 35060014982](https://github.com/askdkc/kiokuko-dsh/actions/runs/35060014982)
failed: the manifest required two untracked generated Unicode test files, and
the repeated-memory upgrade fixture expected migrations only through 18. The
earlier local 394-file check did not establish clean-checkout reproducibility.

After correcting those defects, disabled-session recovery registration and
permission preservation during file replacement, local verification passed:

- A Git archive with the fixes applied and neither generated test file present:
  392-file manifest check, startup integrity check, build, package check and
  `publint --pack npm`.
- That same source copy on macOS 27 / arm64, SBCL 2.6.8: 21 Lisp tests passed,
  one historical opt-in P0 test skipped; real workers and native DSH were used.
- Both repeated-memory upgrade modes passed through migration 19.
- Standard suite: 650 passed, 92 optional/environment tests skipped, no failures
  (742 total). Typecheck passed.

The fixes have not been rerun in remote CI or on Linux/x64. This is local evidence,
not confirmation that the four-platform CI matrix passes.

## Covered behavior

### Automatic compilation follow-up

The reusable FASL cache was checked separately after the original verification
above. macOS 27 / arm64 with SBCL 2.6.8 passed:

- Concurrent first enables compile once; resets and host restart reuse the same
  verified bundle without changing its modification time.
- Lisp write/delete/create and brokered Python write attempts against the shared
  bundle are denied by the OS.
- Changing tool source produces a new bundle with the changed behavior.
- Corrupt bundles stop startup, remain quarantined, and rebuild on explicit recovery.
- Failed, cancelled and timed-out setup leaves no published partial entry.
- The complete native Lisp suite passed 17 tests with one historical P0 opt-in
  test skipped. The standard suite passed 647 tests with 91 optional/environment
  skips (738 total). Typecheck, build, vendor verification, publint and package
  checks passed.
- An extracted npm tarball used its own compiled JS and bundled Lisp files to
  enable, evaluate CSV/arithmetic and recover after host restart. Dependencies
  were linked from the development checkout; this was not a fresh dependency
  installation or another live Web verification.

One sequential run of that extracted tarball recorded **5542 ms** for cold cache
preparation and **209 ms** for reuse. These are single local observations of
preparation only, not an execution-speed benchmark or complete startup timings.

The new cache path has not yet been rerun on Linux or x64 locally. The existing
four-platform Lisp CI job automatically includes its new integration tests; no
remote CI run is claimed here.

### Original protection and recovery verification

- Stateful evaluation, retained references, stale references after recovery,
  CSV/JSON/JSONL/regular expressions, Python, managed jobs and artifact copies.
- Same request replay, concurrent replay, changed-input conflict, durable
  native-call binding, expired-result tombstones and bounded valid JSON output.
- Direct deletion/write and TCP/UDP/Unix socket attempts from Python denied;
  real project files remain unchanged. Lisp direct deletion is also denied.
- Native tools, nested calls, child agents, late tool registration and plugin
  unload cannot reopen unrestricted execution for a protected session. A failure
  while registering the plugin releases its lock and permits a later reload.
- Refusal, skipped answer, unavailable UI and late approval after cancellation
  cause no deletion. Approved deletion retains an independent backup. Restoration
  requires a new approval and checks the backup digest/current target.
- Timeout, output flood, invalid protocol frames and worker restart stop admission.
  A busy supervised child exits when its host is killed.
- Injected result-storage failure leaves the evaluation UNKNOWN and stops the
  worker. Injected completion-record failure after a real file deletion leaves
  the proposal UNKNOWN and blocks recovery until human reconciliation. The test
  then abandons the unknown operation and restores its backup with new approval.
- Parent-link replacement, hard links, protected files and changed contents are
  rejected. New regular files can create required parent directories.

These checks do not claim aggregate OS memory/thread/disk quotas or transactional
isolation from unrelated host applications modifying paths concurrently. Those
limits remain explicit in [the runtime guide](lisp.md). Real database changes and
arbitrary host-tool forwarding remain outside the exposed API.

## Repeat the installed Web check

```sh
npm ci --prefix tests/fixtures/dsh-runtime
KIOKUKO_LISP_SBCL=/absolute/path/to/working/sbcl npm run test:lisp:web
```

The script builds and installs a tarball into a new temporary HOME/profile, makes
one disposable file, and prints the Web URL. No provider API key is needed.
Choose commands through the Web **Commands** menu, then enter their arguments:

1. `kioku-lisp` → `enable`.
2. `lisp-fixture` → `delete`: inspect the exact target and backup, then Refuse.
3. Repeat the deletion and Approve. Verify the original is absent and the backup
   contains `Recoverable verification fixture.` followed by a newline.
4. `lisp-fixture` → `timeout`: inspect the stop reason and use the recovery button.
5. Reload/reconnect and confirm that previous code is never automatically replayed.

The test helper is development-only and is not included in the published file
list. Ctrl+C stops the test host; the printed evidence directory and backups remain.
