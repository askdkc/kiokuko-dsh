# Orca integration verification

Local verification on 2026-09-07, Node.js 26.5.0 / macOS. CI remains pinned to
Node.js 24.16.0; the remote workflow has not been run from this working tree.

| Check | Observed result |
| --- | --- |
| TypeScript typecheck and build | Passed |
| Orca unit/integration tests | 35 passed, no skips; final focused run including both native host modes: 37 passed |
| Full `npm test` | 297 passed, no failures; 12 environment-dependent native/CLI tests skipped in that invocation |
| Required DSH E2E (`KIOKUKO_REQUIRE_DSH_CLI=1`) | 13 passed, zero skipped; DSH 0.1.2-rc.1 |
| Disposable Web profile | Packed plugin installed, Orca enabled by a temporary overlay, authenticated browser bundle materialized, process stopped, plugin removed |
| Empty npm consumer | Installed packed tarball with no dev/global Orca dependencies; recorded/read/exported an actual fixture |
| Lockfile/pack validation | Three runtime packages accept >=0.2.1, with lockfiles resolved to 0.2.1; npm/pnpm tarball integrity agrees; packed imports and relative module closure passed |
| `publint` | Passed |

The full-suite count above records that invocation; the additional hot-reload binding test was subsequently verified in the focused run.

After changing the dependency range to `>=0.2.1`, typecheck, build, all 36 Orca
unit/integration tests, pack validation, and a fresh npm consumer passed again.
The consumer resolved core 0.2.1 and verified that the trace manifest reports its
installed version. The full suite and native E2E were not repeated for that change.

The required E2E runs real Cordis/DSH model and tool events using a fake provider,
including post-policy rejection, two simultaneous sessions, native command
ownership, and unloading during a pending tool gate. No external model API key
or production DSH profile was used. The standalone Web lifecycle verifies loading
and browser bundling; the model/tool scenarios run in the real native composition.
The CLI lifecycle covers the separate install/remove condition skipped by the
ordinary local test invocation.

The test uncovered a real teardown-order issue: Cordis removes plugin-owned
listeners before awaiting effect cleanup. Recording observers now use explicit
root registration and are removed by the adapter after draining the final results
and persisting the trace index, before runtime close.

## Small local performance fixture

One sample, 20 model calls, 1,000 output characters each, local storage, no network.
These numbers include initialization and are not capacity recommendations.

| Metric | Disabled | Enabled |
| --- | ---: | ---: |
| Mean first chunk | 0.030 ms | 0.539 ms |
| Mean interval between chunks | 0.0013 ms | 0.809 ms |
| Stop/drain | 0.142 ms | 18.04 ms |
| Total elapsed | 4.31 ms | 95.23 ms |
| CPU | 14.42 ms | 106.90 ms |
| RSS change | 0.95 MB | 15.20 MB |
| Trace bytes | 0 | 37,258 |

The enabled run completed. RSS includes module loading and runtime allocation;
this single sample is not a memory-leak test. Queue, active-call, event-size and
open-trace ceilings have separate tests. The compressed package was approximately
5.2 MB; dependencies are installed separately by the package manager.

Reproduce with `npm run typecheck`, `npm test`, `npm run build`,
`npm run pack:check`, `npm run publint`, and `npm run test:orca:package`.
For required native verification, install DSH 0.1.2-rc.1 in a disposable directory,
set `DSH_BIN` and `KIOKUKO_DSH_PACKAGE_ROOT` to that installation, then run
`KIOKUKO_REQUIRE_DSH_CLI=1 npm run test:e2e:dsh`.
