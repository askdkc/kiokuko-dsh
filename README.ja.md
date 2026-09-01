# Kiokuko DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh`は、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)向けのout-of-tree Pluginです。
npmにはまだ公開していません。

## 導入

DeepSeek Harness `0.1.2-alpha.3` と Node.js 24.16.0 以上が必要です。

初回のGit導入前に、`web` profileでこのパッケージのbuildを許可します。
失敗したinstallに表示されたcommit付きのkeyを
`~/.dsh/profiles/web/pnpm-workspace.yaml`へ追加してください:

```yaml
allowBuilds:
  "kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/<commit>": true
```

既存の項目は残し、`<commit>`はpnpmが表示した値に置き換えてから、下の導入コマンドを再実行します。

DeepSeek Harnessのcheckoutから導入する場合:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

ローカルcheckoutを使う場合は、先にビルドしてパスを指定します:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
```

インストール済みの`dsh` CLIでは先頭の`pnpm`を外します。削除:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

npm公開前に裸の`kiokuko-dsh`を指定しないでください。npm registryのパッケージとして解決されます。

詳細は[DeepSeek Harness Pluginガイド](docs/dsh-plugin.md)を参照してください。

## License

MIT
