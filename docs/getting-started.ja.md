# 導入ガイド

## インストールと設定

Node.js 24.16.0以上が必要です。対象releaseがnpmに公開済みの場合は、公開済みの`kiokuko-dsh`を導入するのが通常の手順です。

```bash
npm install --global kiokuko-dsh
kiokuko setup
```

local checkoutを使う場合:

```bash
cd /path/to/kiokuko-dsh
pnpm install --frozen-lockfile
pnpm run build
node dist/bin/kiokuko.js setup
```

`--clients codex,opencode,claude,hermes`で対象を明示できます。省略時はインストール済みclientを検出します。
`--dry-run --json`は書き込みなしで計画を出力します。`--no-standard-skills`、`--skill-discovery off|official|community`、
`--enno-oduno on|off`も指定できます。

Codexでは次のmanaged blockを所有します。

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

`required`を含まない完全一致の旧managed blockだけを再実行時に更新します。値、順序、重複key、余分なfieldの変更や
`required = false`はuser-managed conflictとして無断上書きしません。対話実行では置換確認を行い、JSON・非対話・dry-runでは
`CONFLICT`を返して変更しません。他の対応clientも同じ規則です。

起動中のclientは設定後に再起動してください。Codex Stop hookを作成・更新した場合は`/hooks`で明示的にtrustします。
`kiokuko doctor --json`はruntime、DB、Codex MCPを読み取り専用で検査します。

## Embeddings

`kiokuko embeddings setup`は固定semantic runtimeを導入し、`kiokuko setup`と同じclient設定フロー（conflict確認、managed MCP更新、
登録済みプロジェクトのinstructions更新）を実行します。

```bash
kiokuko embeddings setup --clients codex
kiokuko embeddings setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace`は別のembedding profileから切り替える指定です。`--dry-run`はdownloadと変更を行わず、`--json`は自動化向けで
unmanaged MCP identityをfail closedします。

## Web UIとclient

`kiokuko web`を実行し、`http://127.0.0.1:4173`を開きます。UIはローカル限定の管理画面で、model向けMCP呼び出しの代替ではありません。
Enno-Oduno有効時、Codex・OpenCode・Claude Codeには継続adapterがあり、Hermesはnative stdio MCPを使います。

## DeepSeek Harness Plugin

公開済みのビルド済みパッケージを一発で導入できます:

```bash
dsh plugin --profile web add kiokuko-dsh
```

`/kiokuko-soul`を実行する必要はありません。プラグインがポリシーをDSHの
system promptへ自動注入するため、profileを起動してそのまま依頼を入力します
（web profileは`dsh web`）。

source-pinned Git導入では[DeepSeek Harness Plugin](dsh-plugin.md)の自動fallbackを使ってください。
commitを固定し、正確な`allowBuilds`項目を追加し、既存項目を保持してから自動再試行します。

profileを分ける場合は次のようにします。

```bash
dsh plugin --profile kiokuko-test add github:askdkc/kiokuko-dsh
dsh --profile kiokuko-test --dump-config
dsh plugin --profile kiokuko-test remove kiokuko-dsh
```

install/remove、resume安全性、互換性、検証状況は
[DeepSeek Harness Plugin](dsh-plugin.md)を参照してください。
