# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に、プロジェクトの記憶・作業計画・検証支援を追加するプラグインです。
OrcaReplay でモデル・ツールの動作を記録し、内容の確認と HTML 出力もできます。


新しい変更作業では、通常実行か役小角(enno-oduno)を選べます。役小角ではおすすめテンプレート、またはDSH設定済みモデルから役割ごとの構成を選択します。[モデル選択と接続上の制約](docs/model-selection.ja.md)
## 導入と使い方

対応 DSH: `0.1.2-rc.1` / [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1) / [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2)。
Node.js **24.16.0 以上**と pnpm が必要です。
インストール済みの `dsh` CLI で、公開済み npm パッケージを導入して起動します。

```bash
dsh plugin --profile web add kiokuko-dsh
dsh web
```

DSH の checkout から使う場合は、各 `dsh` コマンドの先頭に `pnpm` を付けます。
起動後は普通に依頼を入力します。Kiokuko 専用の setup 操作は不要です。
GitHub・ローカルからの導入は [プラグインガイド](docs/dsh-plugin.md) を参照してください。

OrcaReplay の機能設定は自動導入され、**手動設定は不要**です。チャットの最初に詳細ログを「記録する／記録しない」を選びます。
「記録する」を選ぶと、その後のモデル応答やツール実行結果を作業プロジェクトの `.orca/runs/` に保存します。選択はセッションごとに保持され、スキップ・取消時は記録せず続行します。

- `/kioku-orca start`: 手動で記録を開始、または停止後に再開します。最初に「記録する」を選んだ場合は実行不要です。過去の動作は記録されません。
- `/kioku-orca status`: 機能の有効・無効、セッションの記録選択、記録状態・エラーを確認します。

`/kioku-orca stop` でログを確定後、`list` で run ID を確認し、`show <run ID>` で内容を表示、`export <run ID>` で HTML を出力できます（いずれも `/kioku-orca` に続けて入力）。
無効にする場合は `orca.enabled: false` を設定して再読み込みします。詳細は [記録設定とコマンド](docs/orca-recording.md) を参照してください。

## 更新

作業中のタスクを終えて DSH を停止してから更新します。npm 版の Kiokuko 本体の更新:

```bash
dsh plugin --profile web update kiokuko-dsh --latest
```

Orca の 0.3.0 などが公開された後、Orca 関連の依存を更新する場合:

```bash
dsh plugin --profile web update --depth Infinity '@orcareplay/*'
dsh plugin --profile web why @orcareplay/core
dsh web
```

導入済みの Kiokuko に `>=0.2.1` の依存指定が含まれていることが前提です。
正式版 0.3.0 以降も許可する指定ですが、既存環境が自動更新されるわけではありません。
更新後は記録・HTML 出力を確認してください。[更新の詳細](docs/dsh-plugin.md#update)

[ドキュメント](docs/README.ja.md) · [権限](PERMISSIONS.md) · [MIT ライセンス](LICENSE)
