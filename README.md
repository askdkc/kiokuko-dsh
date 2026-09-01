# Kiokuko (記憶庫)

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect through MCP, recall useful context, and build reusable project memory.**

Kiokuko is local external memory for AI coding agents. It stores durable knowledge
in SQLite, retrieves relevant context for the next task, and records useful results
after work. You keep using your client normally; the client calls Kiokuko through MCP.

## The core idea

```text
request → MCP connection → retrieve relevant memory → do the work
                                             ↓
                                  save reusable knowledge
```

Memory is separated into Project, Ecosystem, and Global scopes. Current source,
configuration, and execution results take precedence over remembered context.

## Quick start

Node.js 24.16.0 or newer is required (Node.js 26.1.0 or newer is also supported).

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` initializes the local database, detects supported clients, installs the
bundled standard Skills, and configures their MCP connection. Restart a client that
was already running after setup. Exact configuration rules and recovery procedures
are in the [Getting started guide](docs/getting-started.md).

## Main features

- **RAG memory**: lexical retrieval by default, with optional local semantic retrieval.
- **Akinator**: clarifies vague requests before work begins.
- **役小角(enno-oduno)**: plans, confirms, verifies, and recovers multi-step agent work.
- **Local Web UI**: review and curate saved memories.
- **Reference-only Skills**: discovered external Skills are verified and never executed automatically.

Enable optional semantic retrieval with the same client setup flow:

```bash
kiokuko embeddings setup
```

Managed MCP blocks are updated and registered-project instructions are refreshed.
An unmanaged identity is replaced only after interactive confirmation; non-interactive
and `--dry-run --json` invocations fail closed without changing it. See the
[semantic retrieval guide](docs/semantic-retrieval.md) for runtime, offline, and
fallback behavior.

## Supported clients

- Codex
- OpenCode
- Claude Code
- Hermes Agent
- DeepSeek Harness (installable out-of-tree Cordis bundle; see [DeepSeek Harness Plugin](docs/dsh-plugin.md))

Client-specific setup, Web UI, and restart instructions are in
[Getting started](docs/getting-started.md). The [documentation index](docs/README.md)
links to conceptual and operational guides.

### DeepSeek Harness Plugin

From a DeepSeek Harness source checkout, install Kiokuko as an out-of-tree
Cordis bundle in the `web` profile:

```bash
pnpm dsh plugin --profile web add @askdkc/kiokuko
pnpm dsh --profile web --dump-config
```

When using an installed dsh CLI, omit the `pnpm` launcher and use `dsh` with
the same arguments.

The plugin exposes only the seven model-facing Kiokuko operations; host-owned
intake, identity, confirmation, advisory, and verification operations remain
behind the host boundary. Unresolved Akinator intake blocks model and tool
execution. See the [DeepSeek Harness Plugin guide](docs/dsh-plugin.md) for
removal, lifecycle, and compatibility details.

## Safety and limitations

Kiokuko does not store full conversations and rejects content that resembles secrets
such as passwords, API keys, tokens, or private keys. Saved memories are advisory;
verify them against the current repository and runtime.

MCP use is client- and model-mediated. There is **no guarantee that Kiokuko is called
on every turn**. If a client cannot initialize the required MCP connection, a client
may stop rather than silently continue without policy. Trust boundaries and public
error behavior are documented in [Security and trust](docs/security-and-trust.md).

## More detail

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [役小角(enno-oduno)](docs/enno-oduno.md)
- [Semantic retrieval](docs/semantic-retrieval.md)
- [Security and trust](docs/security-and-trust.md)
- [CLI contract](docs/cli-contract.md)

Implementation-focused references remain in [architecture](docs/architecture.md),
[database](docs/database.md), [execution ledger](docs/execution-ledger.md), and
[client compatibility](docs/client-compatibility.md).
