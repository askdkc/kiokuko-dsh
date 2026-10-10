# AgenticReplay integration verification

The migration replaces the recorder libraries, configuration (`agenticReplay`),
human command (`/kioku-agenticreplay`), storage (`.agenticreplay`) and manifest
contract. Migration 034 preserves historical tables and copies recording choices
into the new index without importing old traces.

Kiokuko depends on the published `agenticreplay` distribution with
`>=0.1.0 <1.0.0`. Node resolves the bundled core, schema and viewer packages from
that dependency. No global CLI installation, locally built upstream SDK,
separately published scoped package or fixed installation directory is required.
Both lockfiles record the actual registry tarball and integrity. The trace
manifest records the installed core version, rather than a release literal.

The dependency range admits later pre-1.0 patch and minor releases, including
0.2.0. Lockfiles retain the tested version until explicitly updated. This range
does not guarantee that a future upstream release preserves its library APIs or
bundle structure; such a change must pass the same checks before acceptance.

Run from the repository:

```bash
npm ci --ignore-scripts
pnpm install --lockfile-only --frozen-lockfile --ignore-scripts
npm run typecheck
npm test
KIOKUKO_REQUIRE_DSH_NATIVE=1 \
  KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
  node scripts/run-tests.mjs tests/dsh/e2e/agenticreplay-native.test.ts
npm run test:agenticreplay:package
npm run publint
npm run pack:check
npm run test:modules
```

The native check requires the installed pinned DSH fixture and rejects missing
or mismatched runtimes. The default suite's opt-in skips do not establish native
coverage. Recording checks exercise reading, HTML export, native DSH events,
shutdown, limits, redaction, session identity and legacy-manifest rejection.

`test:agenticreplay:package` builds and installs the actual packed plugin in
separate empty npm and pnpm consumers, then records, reads and exports through
their installed libraries. Lifecycle scripts are disabled. The disposable pnpm
consumer disables release age delay only for this acceptance test; it does not
change the user's configuration or build approvals.

`pack:check` checks both lockfiles and package/declaration closure.
`test:modules` checks isolated core, core/enno, core/lisp, core/enno/lisp and full
compatibility packages. Run build-producing checks sequentially because they
replace `dist`.

These checks establish local source and package behavior. They do not establish
remote CI success, publication of Kiokuko, or an update and restart of the user's
running DSH profile.
