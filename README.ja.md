# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に、記憶・計画・検証・動作記録を追加するプラグインです。

## 機能

- **実行方式** — 通常実行と役小角(enno-oduno)を選べます。[詳細](docs/model-selection.ja.md)
- **プロジェクト記憶** — 作業で得た知識を後のタスクで検索できます。[基本概念](docs/concepts.ja.md)
- **Deep Planning** — 四つの役割で読み取り専用の調査・計画を行います。[使い方](docs/deep-planning.md)
- **Continuity** — 既定では無効です。`continuity.mode: active` にすると、最近の実行記録を短くまとめてモデルへ渡します。[設定方法](docs/continuity.ja.md)
- **記憶学習** — 完了した作業から再利用できる episode・教訓候補を作ります。[設定](docs/memory-evolution.md)
- **OrcaReplay** — モデル・ツールの動作を記録し、HTML に出力できます。[設定とコマンド](docs/orca-recording.md)
- **日本語出力** — 対応モデルへ自然な日本語を書く同梱 Skill を渡します。[詳細](docs/japanese-output.md)

## 導入と使い方

対応 DSH: **0.1.6-alpha.1**（[検証範囲](docs/dsh-plugin.md#compatibility)）。

Node.js **24.16.0 以上**と pnpm が必要です。
DSH のソースディレクトリで、公開済み npm パッケージを導入して起動します。

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

グローバルにインストールした `dsh` CLI を使う場合は、各コマンドから `pnpm` を外してください。
起動後は普通に依頼を入力します。Kiokuko 専用の setup 操作は不要です。
GitHub・ローカルからの導入は [プラグインガイド](docs/dsh-plugin.md) を参照してください。

## 更新

作業中のタスクを終えて DSH を停止してから更新します。npm 版の Kiokuko 本体の更新:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

Kiokuko は更新頻度が高く、pnpm 11 では公開後24時間未満のバージョンを
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
により既定で選びません。`update --latest` を実行しても旧版のままになる場合は、
`~/.dsh/profiles/web/pnpm-workspace.yaml`（`pnpm-lock.yaml` ではありません）の
`minimumReleaseAgeExclude` に次を追加し、更新コマンドを再実行します。

```yaml
minimumReleaseAgeExclude:
  - kiokuko-dsh
```

起動時に、日本語出力を含む全8 Skillと参照ファイルを `~/.agents/skills/` へ同期します。不足分を作成し、管理対象の旧版を更新します。非管理ファイルは上書きしません。他のエージェントではSkillカタログの再読み込みが必要です。

起動時には、起動ディレクトリの `AGENTS.md` にある既存の Kiokuko 管理ブロックも更新し、その外側の指示は保持します。パッケージ更新後は DSH を再起動してください。別の作業ディレクトリや配備コピーの確認・修復は[セットアップ手順](docs/dsh-plugin.md#what-setup-updates-and-when)を参照してください。`kiokuko use` は DSH のセットアップコマンドではありません。

Orca の 0.3.0 などが公開された後、Orca 関連の依存を更新する場合:

```bash
pnpm dsh plugin --profile web update --depth Infinity '@orcareplay/*'
pnpm dsh plugin --profile web why @orcareplay/core
pnpm dsh web
```

導入済みの Kiokuko に `>=0.2.1` の依存指定が含まれていることが前提です。
正式版 0.3.0 以降も許可する指定ですが、既存環境が自動更新されるわけではありません。
更新後は記録・HTML 出力を確認してください。[更新の詳細](docs/dsh-plugin.md#update)

既存チャットが `unknown ... not marked ignorable` で開けない場合は、[履歴の修復手順](docs/session-history-repair.md)を参照してください。

DSH 更新後に Kiokuko を読み込めない場合は、[起動失敗時の復旧手順](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)で、対象プロファイルの更新・再導入コマンドを確認してください。履歴や Kiokuko のデータベースは削除しません。API の互換性の問題は、再導入だけでは直らない場合があります。

[ドキュメント](docs/README.ja.md) · [権限](PERMISSIONS.md) · [MIT ライセンス](LICENSE)
## Common Lisp ツール（任意）

事前に SBCL をインストールしてください。

- macOS: `brew install sbcl`
- Debian / Ubuntu: `sudo apt install sbcl`
- Arch Linux: `sudo pacman -S sbcl`

`~/.dsh/profiles/web/cordis.patch.yml` の `kiokuko-dsh` 行に次を追加し（他の `config` 値は保持）、
プラグインを再読み込みしてから対象のセッションで
`/kioku-lisp enable` を実行すると、状態を保持する Common Lisp を利用できます。
読み込まれた設定は `dsh --profile web --dump-config` で確認できます。

```yaml
- id: kiokuko-dsh
  config:
    lisp:
      enabled: true
      sbclPath: sbcl
```

Linux では別途 Bubblewrap が必要です。
削除・既存ファイルの置換はユーザーの確認後に実行します。
[設定、API、停止・復旧方法](docs/lisp.md)を参照してください。
