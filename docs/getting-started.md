# Getting started

`kiokuko-dsh` is a DeepSeek Harness plugin. The published package contains the
`./dsh` plugin entrypoint and does not install or configure Codex, OpenCode,
Claude Code, or a generic `kiokuko` CLI.

## Install

DeepSeek Harness `0.1.2-rc.1` and Node.js 24.16.0 or newer are required.

From a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

To install directly from GitHub, run this from a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a local checkout, build it in the Kiokuko checkout:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Then, from a DeepSeek Harness checkout, install the built path with the
installed `dsh` launcher:

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
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
