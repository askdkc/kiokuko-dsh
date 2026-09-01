# Kiokuko（記憶庫）

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**MCPで接続し、必要な記憶を検索し、作業後に知識を蓄積する。**

KiokukoはAIコーディングエージェント向けのローカル外部メモリです。SQLiteに知識を保存し、
次のタスクに関係する文脈を検索し、作業結果から再利用できる知識を記録します。

## 基本概念

```text
依頼 → MCP接続 → 関係する記憶を検索 → 作業
                                  ↓
                         再利用できる知識を保存
```

記憶はProject・Ecosystem・Globalに分離されます。現在のコード、設定、実行結果が過去の記憶より優先されます。

## 最短セットアップ

Node.js 24.16.0以上が必要です（Node.js 26.1.0以上にも対応）。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup`はローカルDBを初期化し、対応クライアントを検出し、標準SkillとMCP接続を設定します。
起動中のクライアントは、設定後に一度再起動してください。正確な設定規則は
[導入ガイド](docs/getting-started.ja.md)を参照してください。

## 主な機能

- **RAGメモリ**: 標準はlexical検索、任意でローカルsemantic検索。
- **Akinator**: 曖昧な依頼を作業前に具体化。
- **役小角(enno-oduno)**: 複数手順の計画、確認、検証、回復。
- **ローカルWeb UI**: 保存した記憶の確認と整理。
- **参照専用Skill**: 外部Skillは検証して保存するが、自動実行しない。

semantic検索を有効にする場合も、通常のclient設定フローを使います。

```bash
kiokuko embeddings setup
```

managed MCP blockと登録済みプロジェクトのinstructionsを更新します。unmanaged identityの置換は対話確認後だけ行い、
非対話または`--dry-run --json`では変更せずfail closedします。詳細は
[semantic retrievalガイド](docs/semantic-retrieval.ja.md)を参照してください。

## 対応クライアント

Codex、OpenCode、Claude Code、Hermes Agentに対応しています。DeepSeek Harnessには、out-of-tree Cordis bundleとして
対応します（[DeepSeek Harness Plugin](docs/dsh-plugin.md)）。client別の設定、再起動、Web UIは
[導入ガイド](docs/getting-started.ja.md)にまとめています。

### DeepSeek Harness Plugin

DeepSeek Harnessのソースcheckoutから、`web` profileへout-of-tree Cordis bundleとしてインストールします。

```bash
pnpm dsh plugin --profile web add @askdkc/kiokuko
pnpm dsh --profile web --dump-config
```

インストール済みのdsh CLIを使う場合は、`pnpm`を外して同じ引数で`dsh`を実行します。

モデルへ公開するのはKiokukoの7つのmodel-facing operationだけです。intake、identity、確認、advisory、検証などのhost-owned operationは
host境界の内側に残ります。Akinatorのintakeが未解決の間は、モデルとツールの実行を開始しません。削除、lifecycle、互換性は
[DeepSeek Harness Pluginガイド](docs/dsh-plugin.md)を参照してください。

## 安全性と制約

会話全文は保存せず、パスワード、API key、token、秘密鍵に似た内容を拒否します。保存された記憶は参考情報であり、
現在のリポジトリと実行結果で確認してください。

MCPの利用はclientとモデルが決めるため、**毎回必ずKiokukoが呼ばれる保証はありません**。信頼境界と公開エラーは
[Security and trust](docs/security-and-trust.ja.md)で説明しています。

## 詳細ドキュメント

- [ドキュメント目次](docs/README.ja.md)
- [導入ガイド](docs/getting-started.ja.md)
- [基本概念](docs/concepts.ja.md)
- [役小角(enno-oduno)](docs/enno-oduno.ja.md)
- [Semantic retrieval](docs/semantic-retrieval.ja.md)
- [Security and trust](docs/security-and-trust.ja.md)
- [CLI contract](docs/cli-contract.md)

実装者向け資料は[architecture](docs/architecture.md)、[database](docs/database.md)、[execution ledger](docs/execution-ledger.md)、
[client compatibility](docs/client-compatibility.md)を参照してください。
