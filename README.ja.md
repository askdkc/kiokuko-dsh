# Kiokuko(記憶庫) DeepSeek Harness Plugin

メモリ本文の既定上限は Unicode 16,000文字です。関係メタデータは別枠で制限します。[配信予算と関係情報](docs/memory-delivery.md)を参照してください。

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に、記憶・計画・検証・動作記録を追加するプラグインです。

記憶は任意です。作業終了後に整理の許可を聞き、保存案を提示して、その内容への明示的な承認後だけ保存します。従来の自動保存は停止しています。[確認・検索・忘却の仕様](docs/replay-memory-review.md)。

保存した記憶の根拠と訂正履歴は `/kioku-memory explain ENTRY_ID`、明示的な忘却は `/kioku-memory forget ENTRY_ID --revision N` で確認・操作できます。[根拠・説明・忘却の仕様](docs/memory-evidence.md)。

## 機能

- **実行方式** — 通常実行と役小角(enno-oduno)を選べます。[詳細](docs/model-selection.ja.md)
- **プロジェクト記憶** — 作業で得た知識を後のタスクで検索できます。[基本概念](docs/concepts.ja.md)
- **Deep Planning** — 四つの役割で読み取り専用の調査・計画を行います。[使い方](docs/deep-planning.md)
- **DSHのSubagent** — 標準presetで `subagent` と `subagent_fork` を使えます。通常の子agentではKiokukoの実行方式を再選択しません。[設定](docs/dsh-plugin.md#subagents)
- **Continuity** — 既定では無効です。`continuity.mode: active` にすると、最近の実行記録を短くまとめてモデルへ渡します。[設定方法](docs/continuity.ja.md)


- **AgenticReplay** — モデル・ツールの動作を記録し、HTML に出力できます。[設定とコマンド](docs/agenticreplay-recording.md)
- **セッション復旧** — 途中で停止した会話の履歴から続行、または依頼文を引き継いだ空の会話を作成できます。[使い方と制限](docs/session-recovery.md)
- **Diff レビュー** — DSH の右ペインで、選択した差分と Kiokuko の文脈を根拠付きで確認できます。分析は明示操作です。[使い方と制限](docs/diff-review.ja.md)
- **日本語出力** — 対応モデルへ自然な日本語を書く同梱 Skill を渡します。[詳細](docs/japanese-output.md)

Tool exposure の既定値は `auto`。タスク種別と現在の phase に応じて Kiokuko の model tools を絞る。native tools は保持し、`full` で明示的に互換動作へ戻せる。[詳細](docs/tool-exposure.md)。

## 導入と使い方

互換性は公式 DSH の現在のソースと実際のホスト API で検証します。版名を固定した対応判定は行いません。[検証範囲](docs/dsh-plugin.md#compatibility)を参照してください。

対応環境は Linux x64/ARM64 と macOS Apple Silicon です（Intel Mac・Windows は非対応）。

Node.js **24.16.0 以上**と pnpm が必要です。
DSH のソースディレクトリで、Web版を初回導入して起動します。

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

CLI版を初回導入して起動します。

```bash
pnpm dsh plugin --profile dsh-cli add @askdkc/dsh-cli
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
pnpm dsh --profile dsh-cli
```

グローバルにインストールした `dsh` CLI を使う場合は、各コマンドから `pnpm` を外してください。
起動後は普通に依頼を入力します。Kiokuko 専用の setup 操作は不要です。
GitHub・ローカルからの導入は [プラグインガイド](docs/dsh-plugin.md) を参照してください。

記録本文は既定の `capture.content: redacted` を維持します。本文保存を最小化するには `agenticReplay.capture.content: metadata` を選びます。raw記録はありません。既知の資格情報の代入、引用値、認証header、URL内の資格情報を除去し、通常の本文は残します。すべての秘密を検出する保証はなく、過去のtraceやexportには遡及しません。過去ファイルの処理は別途ユーザーが選ぶ操作です。

## 更新

DSH を停止してから、Web版を更新して再起動します。

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

DSH を停止してから、CLI版を更新して再起動します。

```bash
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
pnpm dsh --profile dsh-cli
```

公開から24時間以内のバージョンへ更新する場合は、pnpm 11 の既定の
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
チェックを無効にし、Kiokuko 本体と依存パッケージを更新します。
2行目の出力が `0` であることを確認してから、更新してください。

```bash
pnpm config set --location=global --json minimumReleaseAge 0
pnpm config get minimumReleaseAge
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
```

この設定はグローバルに保存され、以後の pnpm のインストール・更新でも公開後の
待機期間チェックを無効にします。更新が成功したら DSH を再起動してください。

起動時に、日本語出力を含む全16 Skillと参照ファイルを `~/.agents/skills/` へ同期します。不足分を作成し、管理対象の旧版を更新します。非管理ファイルは上書きしません。他のエージェントではSkillカタログの再読み込みが必要です。

ここで説明しているのは全入り構成です。[core と任意モジュールのビルド](docs/core-modules.md)では、選択した資産だけを配布します。core 単独で、Enno/Lisp の実行系を含めずに会話・調査・文章作成・プロジェクトメモリを扱えます。

起動時には、起動ディレクトリの `AGENTS.md` にある既存の Kiokuko 管理ブロックも更新し、その外側の指示は保持します。パッケージ更新後は DSH を再起動してください。別の作業ディレクトリや配備コピーの確認・修復は[セットアップ手順](docs/dsh-plugin.md#what-setup-updates-and-when)を参照してください。`kiokuko use` は DSH のセットアップコマンドではありません。

`agenticreplay` パッケージは `>=0.1.0 <1.0.0` を指定しています。今後のパッチ版・マイナー版は
依存範囲を変えずに更新できます。ロックファイルは明示的に更新するまで検証済みの版を保持します。
更新後は DSH を再起動してください。OrcaReplay から更新する際は、明示的な `orca` 設定を
`agenticReplay` に変更します。保存済みの記録設定は引き継ぎ、旧ログは保持しますが取り込みません。
[更新の詳細](docs/dsh-plugin.md#update) · [記録機能の移行](docs/agenticreplay-recording.md#upgrade-from-orcareplay)

既存チャットが `unknown ... not marked ignorable` で開けない場合は、[履歴の修復手順](docs/session-history-repair.md)を参照してください。

DSH 更新後に Kiokuko を読み込めない場合は、[起動失敗時の復旧手順](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)で、対象プロファイルの更新・再導入コマンドを確認してください。履歴や Kiokuko のデータベースは削除しません。API の互換性の問題は、再導入だけでは直らない場合があります。

[ドキュメント](docs/README.ja.md) · [権限](PERMISSIONS.md) · [MIT ライセンス](LICENSE)
## Common Lisp ツール（任意）

事前に SBCL をインストールしてください。

- macOS: `brew install sbcl`
- Debian / Ubuntu: `sudo apt install sbcl`
- Arch Linux: `sudo pacman -S sbcl`

使用するプロファイルの `~/.dsh/profiles/<profile>/cordis.patch.yml`（`web` または `dsh-cli`）の `kiokuko-dsh` 行に次を追加し（他の `config` 値は保持）、
再読み込み後、明確な通常実装依頼では既定 on-demand の native Bash 経路も含め、最初のモデル要求前に Lisp を提案します。会話・調査・計画だけの依頼には提案を強制しません。その依頼での「使わない」を保持し、Goal 登録後も同じ人間の回答を再利用します。
`/kioku-lisp enable` はこのセッションの明示的な ON です。ON の実装依頼では、小さな関連試作を `lisp_eval`（`prototype: true`）で実行し、成功した保存結果を `lisp_inspect` で確認してから実装ツールへ進みます。ON 表示だけを試作の証拠にしません。試作が2回失敗したら自動再試行を止め、原因修復または `/kioku-lisp disable` で通常経路を選びます。既存の権限と Stop は維持します。ツール表示の `full` は Lisp ON ではありません。新しい依頼には新しい試作証拠が必要で、試作成功だけではタスク完了になりません。
読み込まれた設定は、同じプロファイル名で `dsh --profile <profile> --dump-config` を実行して確認できます。

```yaml
- id: kiokuko-dsh
  config:
    lisp:
      enabled: true
      sbclPath: sbcl
```

既定の開発モードでは Bubblewrap は不要です。Linux で明示的に保護互換モードを選ぶ場合に必要です。
「使う」は Lisp、「使わない」は通常ツール、「取消・作業を保持」は準備内容を残して取消です。閉じる・未回答では実装を始めません。通常実行／役小角の選択は別に保持します。Lisp の起動失敗はブロッカーとして残し、復旧または明示的な経路変更後に再開します。
選択後の通常の編集・テストには追加確認を求めません。ソース・実データの削除と既存の永続DB変更は対象を確認します。各項目の最新の証拠と、通常の利用入口からの最終確認が揃った場合だけ完了します。[Goal 駆動コーディング](docs/coding-workflow.md)と[独自実行、レシート、記憶の再利用](docs/owned-execution.md)を参照してください。
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
/kioku-decisions use openai
/kioku-decisions use nimble
/kioku-decisions use default
```

Layaは`start-laya`で起動済みのworkerへ直接接続します。workerの差し替えやfingerprint設定は不要です。JevにはTypeSafeキー、Nimbleには接続先・モデルの事前設定が必要です。probeが成功してから選択をプロジェクト単位で保存し、次のリクエストへ適用します。再起動後も保持し、進行中のリクエストは変更しません。`use default`でプラグイン設定へ戻せます。

OpenAIは公式 Decisions API (`POST /v1/decisions`、既定モデル `gpt-6-luna`) を使います。DSH credentials の `OPENAI_API_KEY`、credentialsサービスがない構成では同名環境変数が必要です。Jevのキーは使いません。切替時のprobeはAPI呼出しを伴い、失敗・取消時は切替を保存しません。

通常の作業開始時に、decision／Lisp の4通りのON/OFFを一つのカードで選べます。取消・Skipでは開始しません。選択は依頼に保存し、同じ依頼の再処理・再起動・明示的な「続けて」では再利用します。別の依頼では確認し直します。LispがONでも既存の権限・承認・Stopは維持します。ヘッドレスでは既存設定と明示的なLispセッション設定を保ち、`typedDecisions.startup: {decision: true, lisp: true}` でも明示できます。ONは利用成功の証明ではなく、認証不足や判断失敗は記録して主モデルへ戻します。

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

Global記憶の自動生成は停止しています。実行時の適用・検証記録だけで保存を許可せず、提示した保存内容への明示的な承認を必要とします。[保存の承認フロー](docs/replay-memory-review.md)。

### 過去のツール出力の短縮

ObservationPack（既定値 `observationPack: { mode: auto }`）は、大きな正常終了のツール結果をモデルへ2回提示した後、抜粋と `observation_read` で原文を取得できる参照に置き換えます。[Semantic compaction](docs/semantic-compaction.md) は、TODOの完了境界でも前倒し判定を行い、通常・Enno・Lisp モードで、DSH の自動圧縮前に古いツール出力を選んで短縮します。既定値は `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }` です。利用可能と確認された型付き判定バックエンドと、対応するネイティブサービスが必要です。`/kioku-decisions status` で有効状態と直近の結果を確認できます。 完全行の抜粋に元本文を一文字も残せない結果は、packせず全文を保持します。既存のv1 packとhandleは引き続き読み込み・復元できます。

Layaの圧縮には独立した設定があり、`typedDecisions.laya-coreml.compaction.mode: off` が既定です。明示的な `shadow` は履歴を変えずに評価し、`auto` は `experimental_not_qualified` として停止します。ObservationPackとnative summaryは既存設定を維持します。Akinatorは検証済みのdebug／research／writingだけを自動判定し、任意Skillは完全な説明を持つ最大4候補から最大1個を選びます。[Layaの設定と評価](docs/semantic-compaction.md#local-laya)を参照してください。

## 任意のコード解析

`kioku.code` は、`@askdkc/dsh-lsp-server` と連携して、Lisp からコード構造と読み取り専用の LSP 結果を取得します。
導入・更新は `kiokuko-dsh` と同じプロファイルで行います。CLI版では `web` を `dsh-cli` に置き換えてください。

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

[設定・対応言語・制限](docs/code-intelligence.md)を参照してください。
