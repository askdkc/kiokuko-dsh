# Kiokuko DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh@0.1.0`は、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)向けのout-of-tree Pluginで、[npm](https://www.npmjs.com/package/kiokuko-dsh)に公開済みです。

## 導入

DeepSeek Harness `0.1.2-alpha.3` と Node.js 24.16.0 以上が必要です。

公開済みパッケージを導入します:

DeepSeek Harnessのcheckoutから導入する場合:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

source-pinned Git導入は[Pluginガイド](docs/dsh-plugin.md)のfallbackを使ってください。

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

## 使い方

`/kiokuko-soul`を実行する必要はありません。プラグインが`kiokuko-soul`の
ポリシーをDSHのsystem promptへ自動注入します。導入後は`web` profileを
起動して、そのまま依頼を入力してください:

```bash
dsh web
```

詳細は[DeepSeek Harness Pluginガイド](docs/dsh-plugin.md)を参照してください。

## License

MIT
