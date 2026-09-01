# Getting started

## Install and configure

Node.js 24.16.0 or newer is required. Install and configure in two commands:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

Use `--clients codex,opencode,claude,hermes` to select clients explicitly. Without
it, setup detects installed clients. `--dry-run --json` validates and reports planned
changes without writing. `--no-standard-skills`, `--skill-discovery off|official|community`,
and `--enno-oduno on|off` control optional setup behavior.

For Codex, setup owns one exact managed block:

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

The discovery environment line is managed with that block. Rerunning setup upgrades
only the exact previous managed block that omitted `required`. Changed values,
ordering, duplicate keys, extra fields, or an explicit `required = false` are
user-managed conflicts and are never silently overwritten. Interactive setup asks
whether to replace a conflicting identity; JSON, non-interactive, and dry-run calls
return `CONFLICT` without mutation. The same rule applies to other supported clients.

Restart a running client after setup. If a Codex Stop hook is created or updated,
open `/hooks` and explicitly trust it. Use `kiokuko doctor --json` to inspect runtime,
database, and Codex MCP health; doctor is read-only.

## Embeddings setup

`kiokuko embeddings setup` installs the pinned local semantic runtime and runs the
same client configuration flow as `kiokuko setup`, including conflict confirmation,
managed MCP replacement, and registered-project instruction refresh.

```bash
kiokuko embeddings setup --clients codex
kiokuko embeddings setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace` switches from another active embedding profile. `--dry-run` performs no
download or mutation; `--json` is suitable for automation and fails closed on an
unmanaged MCP identity.

## Web UI and clients

Run `kiokuko web` and open `http://127.0.0.1:4173`. The UI is local-only and is a
human/operator management surface, not a substitute for model task-entry MCP calls.
Codex, OpenCode, and Claude Code have bounded continuation adapters when Enno-Oduno
is enabled; Hermes uses native stdio MCP and bundled Skills without an adapter.

## DeepSeek Harness plugin

Install the out-of-tree bundle through the DeepSeek Harness plugin manager:

```bash
npm install --global @askdkc/kiokuko
dsh plugin add @askdkc/kiokuko
```

Use a profile for an isolated test:

```bash
dsh plugin --profile kiokuko-test add @askdkc/kiokuko
dsh --profile kiokuko-test --dump-config
dsh plugin --profile kiokuko-test remove @askdkc/kiokuko
```

See [DeepSeek Harness Plugin](dsh-plugin.md) for the lifecycle contract,
resume safety, compatibility status, and verification command.
