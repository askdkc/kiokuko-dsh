# Configured core and optional modules

The existing `kiokuko-dsh`, `kiokuko-dsh/dsh` and browser client entries retain
the full distribution. `kiokuko-dsh/core` is a separate native DSH host for
ordinary conversation, research, writing and project memory. Merely importing
this subpath from the full npm package does not make that package smaller.

The build tools create private local artifacts with the existing package name
and version. They do not publish new npm packages, install runtimes, update a
profile or restart a running session.

## Build and compose

From this repository, with its locked dependencies installed:

```sh
npm run build
module_stage="$(mktemp -d)"
module_package="$(mktemp -d)"
node scripts/stage-modules.mjs "$module_stage"
node scripts/compose-modules.mjs "$module_stage" "$module_package" lisp
(cd "$module_package" && npm pack --ignore-scripts)
```

Omit `lisp` for core alone; use `enno`, or `enno lisp`, for the other
combinations. Each output directory must be empty. `npm run build:modules`
builds and stages into a fresh directory below `.artifacts/`, printing its path.
Add-on artifacts are overlays for the matching core version, not standalone
installations. The composer checks identity, contract version and file/Skill
collisions, then writes a real Cordis entry, matching declarations, merged
dependencies, compiled resources and a DSH bundle patch. Install the composed
package through the profile's normal local-package workflow; retain the full
package for its existing browser client contributions.

The generated entry accepts the core options (`enabled`, `repositoryRoot`,
`databasePath`, `migrationsDirectory`, `skillPrompts`, `typedDecisions`) and a `modules` object:

```yaml
enabled: true
skillPrompts:
  mode: full
modules:
  lisp:
    enabled: true
```

Lisp remains disabled by default. Enno accepts its intake/model-route,
efficiency, continuity, Enno-memory and finalization settings under
`modules.enno`. Unknown module IDs and invalid module settings fail before
Skill deployment. Enno and Lisp may be installed together; existing host
selection and execution ownership still prohibit using both for one request.

## Ownership and delivery

| Artifact | Executable responsibility | Bundled Skill inventory |
| --- | --- | --- |
| core | Native identity, Akinator, ledger, scoped memory, shared database lifecycle, configured Skill provider | SOUL, memory reasoning, Japanese output |
| Enno add-on | Existing role, lease, verification and continuation adapter | Five coding Skills plus Enno |
| Lisp add-on | Protected runtime, capability fences, approvals, journals, recovery and vendor assets | Five coding Skills plus Lisp |
| Full compatibility package | Existing setup, commands, browser client, Orca, Deep and advanced memory workflows | Existing complete inventory |

SOUL is a constant configured-core prompt. Selected bundled Skills are delivered
through the validated loader; other selected installed Skills are requested by
exact name through native Skill lookup. Selection uses the shared
[typed-decision configuration](typed-decisions.md). Specialized host flows retain their existing delivery.
Full and compiled modes use the same selected resource manifest. Missing or
stale compiled content falls back to validated source from that manifest;
it cannot restore absent modules from a full installation.

Configured startup synchronizes only selected managed Skills and references.
It preserves omitted resources and unrelated files, rejects unmanaged
collisions, and never removes old Skills just because a module was omitted.
Unlike the full compatibility setup, this entry does not rewrite `AGENTS.md`.
Reload the plugin and other agents' Skill catalogs after changing composition.

The core runtime graph excludes Enno, Lisp, Deep, the full host adapter and
the full router. Migration files remain a shared compatibility asset owned
by core: `scripts/module-compatibility-assets.json` is their explicit allowlist.
Existing history and checksums are preserved, including tables for absent
features. Small declaration-only dependencies and passive memory eligibility
readers are retained; they do not start advanced-memory workers. Persisted
Enno/Lisp ownership is read by `modules/legacy-bindings.ts` before ordinary
admission, so removing a module cannot turn protected work into native work.

Enno currently wraps the existing host adapter. Its artifact therefore still
contains compatibility implementations for Deep, Orca and advanced memory;
those features are disabled in the module configuration. They remain available
through the full distribution. The add-on is not yet an independently minimal
Enno implementation. Shared optional interfaces between Enno and Lisp are
byte-checked when combined; neither artifact copies core implementation files.

## Local extension contract

`DshModule` is an internal trusted-code contract, not a public plugin SDK or a
loader for downloaded Skills. A resource-only module provides `resources` and
configuration validation. A runtime feature additionally provides `mount`,
declares required native services and registers host preparation hooks.
`host.admitModules` checks exact request/session/workspace bindings, contract
versions and conflicts. It never grants native permissions. Features own their
persisted state and retain the original lease/outcome recovery checks.

Register acquired resources with `defer` immediately. Shutdown stops all
ingress, drains all modules, then releases resources in reverse order. A failed
drain retains the resources and reports failure. Lisp's root fence survives
unload; stop is not permission to execute ordinary mutation tools.

## Verification and measurements

```sh
# Requires the pinned tests/fixtures/dsh-runtime installation and protected SBCL.
npm run build
npm run test:modules
npm run test:skill-delivery
npm run test:skill-efficiency
```

`test:modules` requires native DSH and an OS sandbox; missing prerequisites
fail instead of becoming skips. It packs and expands core and both add-ons,
assembles all four configurations, validates a TypeScript consumer, resolves
only declared dependency closures, and exercises ordinary requests and
teardown. Lisp configurations additionally execute protected code, check exact
replay and verify the fence after stopping. The full compatibility package is
also tested in isolation. This runner never symlinks the full development
`node_modules` into the consumer. Node type definitions are test tooling.

`.artifacts/module-report.json` records packed/unpacked bytes, file lists,
dependencies, startup imports, Skill inventory and first-request system-prompt
bytes. Set `KIOKUKO_MODULE_BASELINE` to a pre-change full tarball to run it under
the same fixture. Startup counts include resolved dependencies; the prompt
measurement includes native system sections and is not a tokenizer estimate.
Fixture requests establish delivery and execution paths, not live model quality,
token savings, provider cost or wall-clock speedups. No external model is called.
