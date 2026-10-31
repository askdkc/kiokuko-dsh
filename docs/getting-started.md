# Getting started

`kiokuko-dsh` is a DeepSeek Harness plugin. The published package contains the
`./dsh` plugin entrypoint. DSH owns installation, sessions, and lifecycle.

Before choosing OpenAI for auxiliary decisions, follow the [OpenAI Decisions setup](../README.md#openai-decisions-setup) for API-key storage and the Web-profile path distinction. Main-model ChatGPT/Codex OAuth is separate. The guide describes current source support, not a guarantee about the published npm `latest`.

## Install

Use current official DeepSeek Harness and Node.js 24.16.0 or newer. Compatibility is checked against actual host APIs and the resolved upstream source revision, not a fixed DSH release label. See [verified scope](current-upstream-compatibility-report.md).

From a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For the dsh-cli terminal UI, use the separate `dsh-cli` profile:

```bash
pnpm dsh plugin --profile dsh-cli add @askdkc/dsh-cli
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
pnpm dsh --profile dsh-cli
```

Skip the first command when the UI bundle is already installed. For later Kiokuko updates, use `pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest`, then restart that profile. The following Web examples use `web`; substitute `dsh-cli` when working with the terminal profile.

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
explicitly registered DSH integration seams. It does not modify project
instruction files.
