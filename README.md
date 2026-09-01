# Kiokuko DeepSeek Harness Plugin

[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh@0.1.0` is an out-of-tree plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), published
on [npm](https://www.npmjs.com/package/kiokuko-dsh).

## Install

DeepSeek Harness `0.1.2-alpha.3` and Node.js 24.16.0 or newer are required.

Install the published package:

From a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a source-pinned Git install, use the fallback in
[the plugin guide](docs/dsh-plugin.md).

For a local checkout, build it first and pass its path:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
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
