# Historical provider fixture

This patch preserves the original V1 implementation against the exact
`dsh-lsp-server` v0.1.12 base in `upstream.json`. Released
[v0.1.14](https://github.com/askdkc/dsh-lsp-server/releases/tag/v0.1.14) provides
`CodeIntelligenceServiceV1`; users should follow the [installation
guide](../../docs/code-intelligence.md), not apply this patch to that release.

The fixture supplies scoped evaluation leases, bounded parser snapshots and
read-only semantics in the provider. It adds no parser/server runtime to `kiokuko-dsh`
or its core package and does not change an active CLI profile.

Prepare and test the disposable checkout under this repository:

```sh
node scripts/prepare-code-provider.mjs
npm run test:code-intelligence
```

The preparation verifies the official remote and base revision, applies the patch
only when needed, and installs dependencies in the disposable checkout. It never
resets an existing dirty checkout. A conflicting checkout requires review instead
of automatic replacement. The generated TypeScript declaration in
`src/dsh/lisp/code-intelligence-provider.d.ts` must match the provider contract;
the preparation checks it. The declaration is packaged for consumers without the
optional provider installed. All runtime requests still validate negotiated V1
schemas; the declaration does not authorize service calls.

`npm run test:code-intelligence` requires the existing pinned DSH alpha.2 fixture,
SBCL and, for protected mode, the supported native sandbox. It builds the provider,
tests actual grammar/server behavior, and calls the public Lisp API through real
DSH agent tool execution. Packed artifacts are tested separately with
`npm run test:code-intelligence:packed`. The acceptance fixture uses an isolated
workspace and no real user session, credentials or model endpoint.

The provider currently distributes JS/JSX/TS/TSX grammars and the fixed capture IDs
`declarations`, `calls`, `imports`. The WASM grammar package and runtime are pinned
together and tested for UTF-16 positions. Missing grammar and out-of-scope checkout
metadata return explicit outcomes. Unsaved editor overlays are unsupported.

Capabilities report provider limits, disk source kind, grammar support, and actual
negotiated semantic support for live servers. They never start a server merely to
report readiness. Packed Git refs are read through the scoped host filesystem;
linked worktree metadata outside that scope remains unavailable.
