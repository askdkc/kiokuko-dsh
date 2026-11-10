# AgenticReplay integration verification

The migration replaces the recorder libraries, configuration (`agenticReplay`),
human command (`/kioku-agenticreplay`), storage (`.agenticreplay`) and manifest
contract. Migration 034 preserves historical tables and copies recording choices
into the new index without importing old traces.

Kiokuko depends on the published `agenticreplay` distribution with
`latest`. Node resolves the bundled core, schema and viewer packages from
that dependency. No global CLI installation, locally built upstream SDK,
separately published scoped package or fixed installation directory is required.
Both lockfiles record the actual registry tarball and integrity. The trace
manifest records the installed core version, rather than a release literal.

Fresh consumer installations follow npm's `latest` tag. Existing installations
and repository lockfiles retain their resolved version until explicitly updated;
`npm ci` reproduces the locked version. Both repository lockfiles currently
resolve 0.1.18. Future releases must pass the same checks: the tag does not
guarantee compatible library APIs or bundle structure.

To refresh the tested resolution while retaining latest tracking:

```bash
npm update agenticreplay --ignore-scripts
pnpm update agenticreplay --lockfile-only --ignore-scripts
```

Development-only DSH packages explicitly retain the historical 0.2.1-alpha.3
baseline, including the session and tools peers needed to resolve both graphs.
This prevents lockfile regeneration from mixing independently moving `alpha`
tags or selecting unpublished dependencies through old optional peer releases.
It does not pin the supported host: CI stages the current official DSH master
for runtime acceptance, as described in [DSH compatibility](dsh-plugin.md).

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
The distribution test also reads and exports a real synthetic 0.1.9 trace,
including its blob, and checks that historical bytes remain unchanged.

`test:agenticreplay:package` builds and installs the actual packed plugin in
separate empty npm and pnpm consumers, then records, reads and exports through
their installed libraries. Lifecycle scripts are disabled. The disposable pnpm
consumer disables release age delay only for this acceptance test; it does not
change the user's configuration or build approvals.

`pack:check` checks both lockfiles and package/declaration closure.
`test:modules` checks isolated core, core/lisp and full
compatibility packages. Run build-producing checks sequentially because they
replace `dist`.

These checks establish local source and package behavior. They do not establish
remote CI success, publication of Kiokuko, or an update and restart of the user's
running DSH profile.
