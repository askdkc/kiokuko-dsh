# Optional code intelligence

`kioku.code` lets Lisp inspect code structure and read-only LSP results from
files on disk. [@askdkc/dsh-lsp-server v0.1.14](https://github.com/askdkc/dsh-lsp-server/releases/tag/v0.1.14)
provides `CodeIntelligenceServiceV1`; a local provider patch is no longer an
installation prerequisite. The provider owns Tree-sitter, grammars, snapshots
and language servers. Core alone does not load them.

## Install or update

Use Node.js >=24.16.0 and [set up Lisp and SBCL](lisp.md). In the DSH source
directory, install the provider in the same profile as `kiokuko-dsh`:

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
```

For an existing installation:

```sh
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

For CLI, replace `web` with `dsh-cli`. For a global `dsh` installation, omit
`pnpm`. Restart the owning profile, enable Lisp with `/kioku-lisp enable`, then
evaluate this Lisp expression:

```lisp
(kioku.code:capabilities)
```

The provider must be visible in the calling agent's service realm. Check the
response's `status` and `data.languageCapabilities`, `data.sourceKinds`,
`data.queryIds` and `data.limits`. Package installation alone does not establish
that a particular language server is ready.

## Supported operations and limits

The provider bundles these structural grammars:

- JavaScript: `.js`, `.jsx`, `.mjs`, `.cjs`
- TypeScript: `.ts`, `.mts`, `.cts`
- TSX: `.tsx`

PHP, Blade, Svelte, HTML, CSS and Rust structural grammars are not bundled.
Existing LSP routing is separate from structural support. Semantic operations
require a configured server and its negotiated capabilities; capability
inspection does not start a server and may report `server_not_ready`.

Snapshots are disk-only, with zero-based UTF-16, half-open ranges. Handles belong
to one evaluation and cannot be saved for reuse. Query IDs, source spans, result
sizes and evaluation budgets are bounded. Preserve `partial`, `omitted` and
snapshot metadata; a partial count is not the total. See [the API and bounded
aggregation example](lisp.md#read-only-code-intelligence).

## Verification scope

The [optional workflow](../.github/workflows/code-intelligence.yml) configures
source and packed checks on macOS, Ubuntu 26.04 and Arch. Linux uses
`--development-only`; macOS also requests protected execution. A configured job
is not evidence of a pass. Linux protected acceptance
is not established by these checks.

The [local provider patch](../patches/code-intelligence/README.md) remains a
historical regression fixture. `test:code-intelligence` and
`test:code-intelligence:packed` test that fixture, not the installed
registry provider. Do not apply it to a released V1 provider. A failed sandbox
probe leaves protected mode unavailable; it does not reduce isolation.

## Recovery and removal

- `unavailable`: check the profile, service realm and V1 contract, then restart.
- `unsupported` or `server_not_ready`: check language support and server configuration.
- `stale`: open a new snapshot in a new evaluation.
- `partial` or `limit_exceeded`: reduce the request and retain omission metadata.

Disable Lisp with `/kioku-lisp disable` before removing the provider:

```sh
pnpm dsh plugin --profile web remove @askdkc/dsh-lsp-server
```

Use `dsh-cli` for CLI. Removal does not lift protected-session restrictions or
authorize a fallback to generic tools.
