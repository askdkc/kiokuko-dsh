# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

`kiokuko-dsh` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 out-of-tree Plugin。已有发布版本时使用 [npm 包](https://www.npmjs.com/package/kiokuko-dsh)，固定源码的 Git 安装请参阅 Plugin 指南。

## 安装

需要 DeepSeek Harness `0.1.2-alpha.5` 和 Node.js 24.16.0 或更高版本。

安装已发布的 npm 包：

从 DeepSeek Harness checkout 安装：

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

如需从 GitHub 直接安装，请在 DeepSeek Harness checkout 中执行：

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

如需固定 commit 的 Git 安装，请使用 [Plugin 指南](docs/dsh-plugin.md)中的 fallback。

使用本地 checkout 时，先构建再传入路径：

```bash
# 以下两个命令在 Kiokuko checkout 中执行。
pnpm install --frozen-lockfile
pnpm run build
```

然后从 DeepSeek Harness checkout 安装构建后的路径：

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
```

使用已安装的 `dsh` CLI 时去掉开头的 `pnpm`。删除：

```bash
dsh plugin --profile web remove kiokuko-dsh
```

## 使用

无需运行 `/kiokuko-soul`。插件会自动将内置的 `kiokuko-soul` 策略注入 DSH
的 system prompt。安装后启动 `web` profile，直接输入任务即可：

```bash
dsh web
```

详见 [DeepSeek Harness Plugin 指南](docs/dsh-plugin.md)。

## License

MIT
