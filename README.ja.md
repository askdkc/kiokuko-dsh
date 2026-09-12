# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に、プロジェクトの記憶・作業計画・検証支援を追加するプラグインです。
OrcaReplay でモデル・ツールの動作を記録し、内容の確認と HTML 出力もできます。


新しい変更作業では、通常実行か役小角(enno-oduno)を選べます。役小角ではおすすめテンプレート、またはDSH設定済みモデルから役割ごとの構成を選択します。[モデル選択と接続上の制約](docs/model-selection.ja.md)

`/deep-planning <問題>` は、四つの役割による読み取り専用の調査・分析・計画作成です。入力を保持し、一時停止・復旧に対応します。推定予算に達した場合も部分回答を返します。[操作・予算・復旧の仕様](docs/deep-planning.md)

DeepSeek・Kimi・GLM・Qwen・HY/Hunyuan・MiMo・MiniMaxのAgentには、日本語を自然に整える同梱Skillを自動で渡します。[適用条件とモデル判定](docs/japanese-output.md)

## 導入と使い方

対応 DSH: [0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) / [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1) / [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2)。
Node.js **24.16.0 以上**と pnpm が必要です。
DSH のソースディレクトリで、公開済み npm パッケージを導入して起動します。

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

グローバルにインストールした `dsh` CLI を使う場合は、各コマンドから `pnpm` を外してください。
起動後は普通に依頼を入力します。Kiokuko 専用の setup 操作は不要です。
GitHub・ローカルからの導入は [プラグインガイド](docs/dsh-plugin.md) を参照してください。

OrcaReplay の機能設定は自動導入され、**手動設定は不要**です。各チャットは確認なしで詳細ログを記録します。
記録すると、モデル応答やツール実行結果が作業プロジェクトの `.orca/runs/` に保存されます。判断はセッションごとに保持されるため、`/kioku-orca stop` したチャットは記録されないままです。毎回確認したい場合は `orca.askOnStart: true` を設定します。

- `/kioku-orca start`: 手動で記録を開始、または停止後に再開します。そのチャットを停止していなければ実行不要です。過去の動作は記録されません。
- `/kioku-orca status`: 記録状態・保存先・次の操作を短く表示します。診断用の詳細情報は `/kioku-orca status --json` で確認できます。

`/kioku-orca stop` でログを確定後、`list` で run ID を確認し、`show <run ID>` で内容を表示、`export <run ID>` で HTML を出力できます（いずれも `/kioku-orca` に続けて入力）。
無効にする場合は `orca.enabled: false` を設定して再読み込みします。詳細は [記録設定とコマンド](docs/orca-recording.md) を参照してください。

終了した作業から episode と教訓候補を生成します。初期設定の `active` では、根拠が有効な候補を次のセッションの検索・自動注入に使います。候補生成だけにする場合は `observe`、停止する場合は `off` を指定します。状態は `/kioku-evolution status`、詳細は [記憶学習の設定・検証](docs/memory-evolution.md) を参照してください。

## 更新

作業中のタスクを終えて DSH を停止してから更新します。npm 版の Kiokuko 本体の更新:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
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

[ドキュメント](docs/README.ja.md) · [権限](PERMISSIONS.md) · [MIT ライセンス](LICENSE)
