# Getting started

`kiokuko-dsh` is a DeepSeek Harness plugin. The published package contains the
`./dsh` plugin entrypoint and does not install or configure Codex, OpenCode,
Claude Code, or a generic `kiokuko` CLI.

## Install

DeepSeek Harness `0.1.2-alpha.3` and Node.js 24.16.0 or newer are required.

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a local checkout:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
```

## Use

Do not invoke `/kiokuko-soul` manually; the plugin injects the bundled
`kiokuko-soul` policy into DSH's system prompt.

```bash
dsh web
```

Remove the plugin from the selected profile with:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

The plugin owns only its DSH composition, local Kiokuko runtime state, and the
explicitly registered DSH integration seams. It does not modify client MCP
configuration or project instruction files.
