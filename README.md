# Kiokuko(記憶庫) DeepSeek Harness Plugin

[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh` is an out-of-tree plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Use the
[npm package](https://www.npmjs.com/package/kiokuko-dsh) when a published
release is available, or use the source-pinned Git path in the plugin guide.

## Install

DeepSeek Harness `0.1.2-rc.1` and Node.js 24.16.0 or newer are required.

Install the published package:

From a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a source-pinned Git install, use the fallback in
[the plugin guide](docs/dsh-plugin.md).

For a direct GitHub install from a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a local checkout, build it first and pass its path:

```bash
# Run these two commands in the Kiokuko checkout.
pnpm install --frozen-lockfile
pnpm run build
```

Then, from a DeepSeek Harness checkout, install the built path:

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
```

With an installed `dsh` CLI, omit the `pnpm` launcher. Remove the plugin with:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

## Usage

Do not run `/kiokuko-soul`. The plugin injects the bundled `kiokuko-soul`
policy into DSH's system prompt automatically. After installation, start the
`web` profile and enter your task:

```bash
dsh web
```

See [the DeepSeek Harness Plugin guide](docs/dsh-plugin.md) for runtime details.

## License

MIT
