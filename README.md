# Kiokuko DeepSeek Harness Plugin

`@askdkc/kiokuko` is an out-of-tree plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds
Kiokuko memory, Akinator intake, Enno-Oduno orchestration, and verification
boundaries to a DeepSeek Harness Cordis profile without forking or patching
the Harness source tree.

This repository is the DeepSeek Harness plugin project. It is not an OpenCode
plugin and it is not the general Kiokuko MCP setup guide.

## Install from a DeepSeek Harness checkout

DeepSeek Harness `0.1.2-alpha.3` is the compatibility target. From its source
repository, with Node.js 24.16.0 or newer, install the plugin into the `web`
profile:

```bash
pnpm dsh plugin --profile web add @askdkc/kiokuko
pnpm dsh --profile web --dump-config
```

To remove it:

```bash
pnpm dsh plugin --profile web remove @askdkc/kiokuko
```

When using an installed `dsh` CLI instead of the Harness source checkout, use
the same commands without the `pnpm` launcher:

```bash
dsh plugin --profile web add @askdkc/kiokuko
dsh --profile web --dump-config
```

The plugin adds one bundle row, `kiokuko-dsh`. Removal only removes that row
and does not modify unrelated plugins, repository files, MCP configuration,
or `AGENTS.md`.

## What the plugin enforces

- The exact bundled `kiokuko-soul` and six standard Skills are provided through
  the Harness Skill and system-prompt surfaces.
- Akinator runs before the main model request. An unresolved question blocks
  model and non-Kiokuko tool execution.
- Fourteen Kiokuko operations are available to the integration, but only the
  seven model-facing operations are exposed as model tools. Host-owned intake,
  identity, confirmation, advisory, and verification operations stay behind
  the host boundary.
- Tool phase, run, revision, route, lease, and idempotency checks are applied
  before tool bodies run.
- DeepSeek `SessionEvent` records are bridged losslessly and idempotently to
  the Kiokuko ledger, with awaited flush barriers before model/tool dispatch
  and terminal close.
- Enno-Oduno verification is a hard turn-stopping gate. Incomplete or failed
  verification forces a corrective step; accepted work must pass meditation
  before completion.

## Authority boundary

Kiokuko SQLite is the semantic authority for memory, Akinator, Enno-Oduno
state, receipts, leases, and verifier evidence. DeepSeek `SessionEvent` is the
authority for the current session's ordered model-visible transcript and tool
evidence. `session/event` observes committed events; it cannot veto an already
executed external side effect. Flush, tool pre-execution, model dispatch, and
turn-stopping are the enforcement boundaries.

The plugin does not automatically install or execute external Skills, perform
Git rollback, modify repository files, or expose continuation tokens to the
model.

## Compatibility

| Harness surface | Status |
| --- | --- |
| `web` | Contract and host-adapter coverage included |
| `headless` | Contract coverage included |
| `sdk` | Unsupported without a real SDK host composition |
| `acp` | Unsupported without a real ACP host composition |
| `sdk-minimal` | Unsupported without a real SDK-minimal host composition |

`web` and `headless` are compatibility targets, not claims that an external
DeepSeek binary was executed. OpenCode, Codex, Claude Code, and Hermes Agent
are outside this repository's plugin surface; their Kiokuko integration uses
the separate MCP/client setup in the main Kiokuko project.

## Verification

Run from this checkout:

```bash
npm run typecheck
node scripts/run-tests.mjs tests/dsh
npm run build
npm run pack:check
npm run test:e2e:dsh
```

`test:e2e:dsh` always runs the in-memory composition and package checks. The
real install/dump-config/remove portion runs only when a `dsh` executable is
available; otherwise it reports `unsupported` instead of claiming a passing
CLI installation.

See [the DeepSeek Harness Plugin guide](docs/dsh-plugin.md) for the detailed
runtime contract, lifecycle behavior, removal semantics, and known limits.

## License

MIT
