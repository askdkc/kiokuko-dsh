# Optional code intelligence

Kiokuko's `kioku.code` API consumes `CodeIntelligenceServiceV1` in the calling
agent's service realm. Tree-sitter, grammars, snapshots and language servers
belong to `@askdkc/dsh-lsp-server`. Core alone does not load them.

The published provider 0.1.12 does not expose V1. This repository includes a
[reproducible local upstream patch](../patches/code-intelligence/README.md), not a
published replacement. Installing the registry's 0.1.12 alone returns
`unavailable` with `provider_missing`; it does not enable this API.

## macOS

Use Node >=24.16.0 and install SBCL:

```sh
brew install sbcl
```

The local acceptance path was exercised on macOS 27.0.1 arm64, Node 26.5.0,
SBCL 2.6.8, DSH 0.2.1-alpha.2, Cordis 4.0.5-alpha.1 and CLI 0.14.4. Both
development and the native Seatbelt-protected Lisp path are tested. A failed
sandbox probe keeps protected mode unavailable; it does not downgrade isolation.

## Ubuntu 26.04

Use Node >=24.16.0 and install the development prerequisites:

```sh
sudo apt update
sudo apt install sbcl git python3 build-essential
```

The Ubuntu 26.04 CI job runs development-mode source and packed acceptance.
That job has not been executed in this local macOS checkout. Linux protected
mode needs the existing Bubblewrap, namespace and seccomp probes; this guide
does not claim a verified Ubuntu protected configuration.

## Arch Linux

Use Node >=24.16.0 and install the development prerequisites:

```sh
sudo pacman -Syu sbcl git python base-devel
```

The Arch CI job runs the same development-mode source and packed acceptance.
That job has not been executed locally. Protected mode remains subject to the
existing Linux sandbox probes and separate acceptance.

## Prepare and test the local preview

Run these from this repository after its dependencies and the existing pinned
`tests/fixtures/dsh-runtime` dependencies are installed:

```sh
node scripts/prepare-code-provider.mjs
npm run test:code-intelligence
npm run test:code-intelligence:packed
```

On an environment where only development is being tested:

```sh
npm run test:code-intelligence -- --development-only
npm run test:code-intelligence:packed -- --development-only
```

Preparation uses the reviewed official provider base and verifies the consumer
contract against it. It does not reset an existing checkout. The packed recipe
creates `.artifacts/code-intelligence/profile`, installs local provider/suite
tarballs with scripts disabled, verifies actual DSH bundle discovery, then mounts
CLI 0.14.4's host services and invokes the public Lisp tools. This is an isolated
acceptance fixture, without model credentials or the interactive TUI. It does not
change a live profile or prove a live browser session.

## Activate a chosen profile

For Web, use the existing `web` profile. For CLI, use the existing `dsh-cli`
profile and its intended preset. Add both local artifacts to that same profile:

```sh
dsh plugin --profile web add "kiokuko-dsh@file:/absolute/path/to/suite.tgz"
dsh plugin --profile web add "@askdkc/dsh-lsp-server@file:/absolute/path/to/provider.tgz"
dsh --profile web --dump-config
```

For CLI replace `web` with `dsh-cli`, inspect the resulting preset rows, then
start `dsh --profile dsh-cli`. The preview tarballs are under
`.artifacts/code-intelligence/pack-suite` and `pack-provider`; use the actual
generated filenames. These are manual profile-changing commands, not actions
performed by the acceptance recipe. Do not install Tree-sitter or another
TypeScript server into Kiokuko.

Enable Lisp with `/kioku-lisp enable` in the intended session. First evaluate:

```lisp
(kioku.code:capabilities)
```

An accepted response reports `sourceKinds`, `limits`, `queryIds` and
`languageCapabilities`. Grammar support and negotiated semantic support are
separate. Capability inspection does not start a server: `server_not_ready`
can be reported until a semantic request starts and negotiates it. Missing
grammars and unconfigured languages remain unsupported. The preview distributes
JS, JSX, TS and TSX; it does not claim PHP, Blade, Svelte or Rust grammar support.
PHPantom and rust-analyzer remain prerequisites for their existing provider APIs.

Use [the bounded aggregation example](lisp.md#read-only-code-intelligence):
select files, obtain outlines, filter/count in Lisp, and request only chosen
spans or semantic results. Include processed/unprocessed counts, failures,
omissions and snapshot versions. A `partial` count is not the total population.

## Updates, disable and recovery

Use the ordinary plugin update mechanism for a released V1-compatible provider.
For this local preview, prepare reviewed source, rebuild/repack and explicitly
replace its local artifact. Restart/reload the owning profile and recheck
capabilities. Never restore saved handles: each evaluation owns and releases its
live snapshots. An unknown provider major version is rejected.

Disable Lisp with `/kioku-lisp disable` before removing the optional provider:

```sh
dsh plugin --profile dsh-cli remove @askdkc/dsh-lsp-server
```

Choose `web` for the Web profile. Existing protected session fences remain
fail-closed after plugin disposal; removing a plugin does not authorize generic
tools. CLI also denies child-session generic tools under a protected parent
fence in development mode. A child cannot borrow its parent's code lease.

| Outcome | Next action |
| --- | --- |
| `unavailable`, missing service/version | Check the intended realm and installed provider's V1 contract; reload the profile. |
| `unsupported`, grammar or semantic capability | Choose a supported language/operation; do not substitute another parser or tool. |
| Semantic unready or `timeout` | Check configured server readiness and retry in a new bounded evaluation. No diagnostics publication means no verified clean result. |
| `stale` | Explicitly reopen the source in a new evaluation after checking the current workspace/checkout. |
| Scope/identity denial | Restore the owning session/provider; do not change root or owner arguments. |
| `limit_exceeded` or `partial` | Reduce files, captures or spans; retain omission metadata. |

All snapshots are disk-only, zero-based UTF-16 and half-open. Linked Git worktree
metadata outside the scoped filesystem is unavailable; no raw filesystem fallback
is used. Ordinary Git loose and packed refs are checked for checkout changes.

Run `npm run test:code-intelligence:benchmark` for the fixed comparison corpus.
It measures host time/RSS, serialized payload bytes and round trips. It does not
measure model tokens, model correctness or child language-server RSS, and does
not guarantee a speedup or lower memory use.
