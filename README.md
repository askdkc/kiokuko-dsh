# Kiokuko DeepSeek Harness Plugin

[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh` is an out-of-tree plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
The package is not published to npm yet.

## Install

DeepSeek Harness `0.1.2-alpha.3` and Node.js 24.16.0 or newer are required.

Before the first Git install, allow this package's build in the `web` profile.
The failed install prints the exact commit key to add to
`~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/<commit>": true
```

Keep existing entries, replace `<commit>` with the value pnpm printed, then
run the install command below again.

From a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

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

Do not use bare `kiokuko-dsh` until the package is published to npm; that form
asks npm for a registry package.

See [the DeepSeek Harness Plugin guide](docs/dsh-plugin.md) for runtime details.

## License

MIT
