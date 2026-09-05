# Kiokuko DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh`は、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)向けのout-of-tree Pluginです。[npmパッケージ](https://www.npmjs.com/package/kiokuko-dsh)に公開済みのreleaseがある場合はそれを使い、source-pinned Git導入ではPluginガイドの手順を使います。

## 導入

DeepSeek Harness `0.1.2-rc.1` と Node.js 24.16.0 以上が必要です。

公開済みパッケージを導入します:

DeepSeek Harnessのcheckoutから導入する場合:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

GitHubを直接指定して導入する場合は、DeepSeek Harnessのcheckoutから実行します:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

commitを固定するsource-pinned Git導入は[Pluginガイド](docs/dsh-plugin.md)のfallbackを使ってください。

ローカルcheckoutを使う場合は、先にビルドしてパスを指定します:

```bash
# 次の2つはKiokuko checkoutで実行します。
pnpm install --frozen-lockfile
pnpm run build
```

その後、DeepSeek Harnessのcheckoutからビルド済みパスを導入します:

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
```

インストール済みの`dsh` CLIでは先頭の`pnpm`を外します。削除:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

## 使い方

`/kiokuko-soul`を実行する必要はありません。プラグインが`kiokuko-soul`の
ポリシーをDSHのsystem promptへ自動注入します。導入後は`web` profileを
起動して、そのまま依頼を入力してください:

```bash
dsh web
```

詳細は[DeepSeek Harness Pluginガイド](docs/dsh-plugin.md)を参照してください。作業条件の指定、探索の一時停止と再開、証拠の扱いは[対話を継続する作業支援](docs/execution-support.md)にまとめています。

## License

MIT
