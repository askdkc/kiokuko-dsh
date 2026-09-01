# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

`kiokuko-dsh` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 out-of-tree Plugin。
该包尚未发布到 npm。

## 安装

需要 DeepSeek Harness `0.1.2-alpha.3` 和 Node.js 24.16.0 或更高版本。

首次从 Git 安装前，请在 `web` profile 中允许此包执行构建。
将失败安装时 pnpm 显示的带 commit 的 exact key 添加到
`~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/<commit>": true
```

保留已有条目，将 `<commit>` 替换为 pnpm 显示的值，然后重新运行下面的安装命令。

从 DeepSeek Harness checkout 安装：

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

使用本地 checkout 时，先构建再传入路径：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
```

使用已安装的 `dsh` CLI 时去掉开头的 `pnpm`。删除：

```bash
dsh plugin --profile web remove kiokuko-dsh
```

npm 发布前不要直接指定 `kiokuko-dsh`，否则会被当作 npm registry 包解析。

详见 [DeepSeek Harness Plugin 指南](docs/dsh-plugin.md)。

## License

MIT
