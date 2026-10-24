# 導入ガイド

`kiokuko-dsh`はDeepSeek Harness向けPluginです。公開パッケージが提供する
のは`./dsh` Plugin entrypointだけです。導入、session、lifecycleはDSHが所有します。

## インストール

公式 DeepSeek Harness の現在のソースと Node.js 24.16.0 以上を使用します。DSH の版名による固定判定はせず、実際のホスト API と解決したソース revision に対する隔離試験で互換性を確認します。[検証範囲](current-upstream-compatibility-report.md)を参照してください。

DeepSeek Harnessのcheckoutから導入します:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

GitHubを直接指定する場合は、DeepSeek Harnessのcheckoutから実行します:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

local checkoutを使う場合は、Kiokuko checkoutでビルドします:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

その後、DeepSeek Harnessのcheckoutからインストール済みの`dsh` launcherで
ビルド済みパスを導入します:

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
```

## 使い方

Pluginが同梱の`kiokuko-soul`ポリシーをDSHのsystem promptへ注入します。
`/kiokuko-soul`を手動実行する必要はありません。

```bash
dsh web
```

profileから削除する場合:

```bash
dsh plugin --profile web remove kiokuko-dsh
```

Pluginが所有するのはDSHのcomposition、ローカルのKiokuko runtime state、
明示的に登録されたDSH integration seamだけです。projectのinstruction fileは
変更しません。
