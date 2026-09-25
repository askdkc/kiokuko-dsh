# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に、記憶・計画・検証・動作記録を追加するプラグインです。

自動メモリレビューは、人間の入力を処理した8ターンごとに、開いたままの会話から有用な記憶候補を保存・更新します。標準で有効で、会話のモデルを使用します。状態は `/kioku-memory-review status`、会話の保存除外は `/kioku-memory-review exclude session` で操作できます。[設定・費用・復旧方法](docs/auto-memory-review.md)。

## 機能

- **実行方式** — 通常実行と役小角(enno-oduno)を選べます。[詳細](docs/model-selection.ja.md)
- **プロジェクト記憶** — 作業で得た知識を後のタスクで検索できます。[基本概念](docs/concepts.ja.md)
- **Deep Planning** — 四つの役割で読み取り専用の調査・計画を行います。[使い方](docs/deep-planning.md)
- **Continuity** — 既定では無効です。`continuity.mode: active` にすると、最近の実行記録を短くまとめてモデルへ渡します。[設定方法](docs/continuity.ja.md)
- **記憶学習** — 完了した作業から再利用できる episode・教訓候補を作ります。[設定](docs/memory-evolution.md)
- **OrcaReplay** — モデル・ツールの動作を記録し、HTML に出力できます。[設定とコマンド](docs/orca-recording.md)
- **Diff レビュー** — DSH の右ペインで、選択した差分と Kiokuko の文脈を根拠付きで確認できます。分析は明示操作です。[使い方と制限](docs/diff-review.ja.md)
- **日本語出力** — 対応モデルへ自然な日本語を書く同梱 Skill を渡します。[詳細](docs/japanese-output.md)

## 導入と使い方

実行環境の対応対象は **DSH 0.1.7-rc.2** です。ネイティブ要求経路、旧セッション履歴の移行、パッケージ化した Web の起動試験はローカルで通過しました（[検証範囲](docs/dsh-plugin.md#compatibility)）。

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

起動時に、日本語出力を含む全9 Skillと参照ファイルを `~/.agents/skills/` へ同期します。不足分を作成し、管理対象の旧版を更新します。非管理ファイルは上書きしません。他のエージェントではSkillカタログの再読み込みが必要です。

ここで説明しているのは全入り構成です。[core と任意モジュールのビルド](docs/core-modules.md)では、選択した資産だけを配布します。core 単独で、Enno/Lisp の実行系を含めずに会話・調査・文章作成・プロジェクトメモリを扱えます。

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
プラグインを再読み込みすると、最初の実装・不具合修正の前に Lisp モードを使うか確認します。
選択はセッション内で保持します。`/kioku-lisp enable` でも有効にできます。
読み込まれた設定は `dsh --profile web --dump-config` で確認できます。

```yaml
- id: kiokuko-dsh
  config:
    lisp:
      enabled: true
      sbclPath: sbcl
```

Linux では別途 Bubblewrap が必要です。
Lisp を選ぶと、Lisp 用ツールで通常実行します。役小角を使う場合は「Lispモードを使わない」を選んでください。
自由入力は相談・訂正として AI に渡します。
削除・既存ファイルの置換はユーザーの確認後に実行します。
[設定、API、停止・復旧方法](docs/lisp.md)を参照してください。

## 型付き判定（Jev / Laya / Nimble）

任意の[モデル自動選択](docs/model-selection.ja.md#通常実行のモデル自動選択)は、新しい通常タスクで検証済みの `openai-codex` モデルと推論強度を選びます。既定値は `modelAutoMode.mode: off` です。`/kioku-model-auto on | observe | off | status` は現在のセッションだけを変更します。`observe` は候補を計測し、実モデルは変えません。利用にはJevかLayaの準備完了、dsh-codex、DSHのモデル情報とtoken meterが必要です。判定不能なら現在のモデルを維持し、手動選択を優先します。

[回答の再検討](docs/answer-review.md)は、表示済みの通常回答を評価し、指摘があれば同じ主モデルに一度だけ見直させる機能です。通常版・modular coreで既定で有効です。既定値は次のとおりです。

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

無効にする場合は `answerReview.mode: off` を指定します。評価providerは `typedDecisions` のJev／Laya／Nimbleを継承します。選択したproviderが利用できない場合は評価をスキップし、元の回答で終了します。別providerへの自動切替はありません。最初の回答はそのまま表示され、評価の追加推論と、最大1回の主モデルによる再検討が発生します。Laya v1はworker内部の切り詰めを確認できないため、指摘は未確認の候補として扱います。`/kioku-decisions status` で進行状態・スキップ理由を確認できます。正しさを保証する機能ではありません。


Jevが既定です。DSHのコマンド入力欄で切り替えられます。設定編集や再起動は不要です。

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Layaは`start-laya`で起動済みのworkerへ直接接続します。workerの差し替えやfingerprint設定は不要です。JevにはTypeSafeキー、Nimbleには接続先・モデルの事前設定が必要です。probeが成功してから選択をプロジェクト単位で保存し、次のリクエストへ適用します。再起動後も保持し、進行中のリクエストは変更しません。`use default`でプラグイン設定へ戻せます。

APIキーは DSH の `~/.dsh/.credentials.yaml`（`DSH_HOME` を設定している場合は `$DSH_HOME/.credentials.yaml`）に書くか、`/kioku-typesafe-key YOUR_KEY` で保存します。既存の項目は残してください。

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: YOUR_KEY
```

YAMLファイルを手動で作る場合は `chmod 600 ~/.dsh/.credentials.yaml` を実行してください（`DSH_HOME` を設定している場合はそのパスを使用）。

DSHのコマンド入力欄で利用可能な状態を確認します。

```text
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe` は検査用のAPIリクエストを送ります。`status` は送信しません。保存したキーは `/kioku-typesafe-key clear` で削除できます。`/kioku-typesafe-key YOUR_KEY` の入力中はキーが画面に表示されます。詳しくは[型付き判定](docs/typed-decisions.md)と[Lispからの明示的な呼び出し](docs/typesafe.md)を参照してください。

Jevが既定です。Nimbleとローカルの[Laya-CoreML](docs/Laya-CoreML-ja.md)も選べます。Layaは`~/Library/Caches/laya-coreml/worker.sock`へ直接接続し、既存のv1 `health`/`predict`を使います。`/kioku-decisions install-laya`でも起動済みworkerを利用でき、接続できなければ導入手順を案内します。

英語を含め、どの言語でも `aac6fef/laya-multilingual-coreml` を使います。入力上限は質問・選択肢・判定対象を合わせて1,024 tokensで、`-ane` 版は96 tokensのみです。[開発元のモデル仕様](https://github.com/mizorewww/laya-coreml#available-checkpoints)を参照してください。[初期導入](docs/Laya-CoreML-ja.md)を済ませてから、次のコマンドを実行します。起動中のLaya workerがあれば停止してから新しいモデルで起動してください。`LAYA_MODEL` の指定は、既存workerスクリプトの古い既定値も上書きします。

```bash
mkdir -p ~/.local/share/laya-coreml/multilingual
hf download \
  aac6fef/laya-multilingual-coreml \
  --local-dir ~/.local/share/laya-coreml/multilingual
LAYA_MODEL="$HOME/.local/share/laya-coreml/multilingual" start-laya
```

## 過去の記憶を意味で選別

TypeSafe または Nimble の利用確認が成功すると、既存検索の候補を今回の依頼に使えるか判定します。埋め込みは必須ではありません。`memoryReuse.mode: off` で停止できます。[設定・確認コマンド・評価方法](docs/memory-reuse.md)を参照してください。

[記憶の適用と検証](docs/memory-application.md)では、採否とホストが観測した回帰検証を記録します。現在の会話の状態は `/kioku-memory-application status`、詳細は `/kioku-memory-application status --json` で確認できます。

同じ候補を独立した3つの完了runで採用・検証すると、適用条件と移植可能性を確認したうえで `source_verified` のGlobal記憶を自動生成します。[条件・停止設定](docs/auto-globalization.md)。

### 過去のツール出力の短縮

ObservationPack（既定値 `observationPack: { mode: auto }`）は、大きな正常終了のツール結果をモデルへ2回提示した後、抜粋と `observation_read` で原文を取得できる参照に置き換えます。[Semantic compaction](docs/semantic-compaction.md) は、TODOの完了境界でも前倒し判定を行い、通常・Enno・Lisp モードで、DSH の自動圧縮前に古いツール出力を選んで短縮します。既定値は `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }` です。利用可能と確認された型付き判定バックエンドと、対応するネイティブサービスが必要です。`/kioku-decisions status` で有効状態と直近の結果を確認できます。
