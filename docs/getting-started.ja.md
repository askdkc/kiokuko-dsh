# 導入ガイド

`kiokuko-dsh`はDeepSeek Harness向けPluginです。公開パッケージが提供する
のは`./dsh` Plugin entrypointだけで、Codex、OpenCode、Claude Code、汎用
`kiokuko` CLIの導入・設定は行いません。

## インストール

DeepSeek Harness `0.1.2-alpha.3` と Node.js 24.16.0 以上が必要です。

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

local checkoutを使う場合:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh plugin --profile web add /path/to/kiokuko-dsh
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
明示的に登録されたDSH integration seamだけです。clientのMCP設定や
projectのinstruction fileは変更しません。
