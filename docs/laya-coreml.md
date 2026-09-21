# Laya-CoreML のローカル判定

Jev／TypeSafeが既定です。Nimbleも継続して使えます。Layaは手動で選ぶ任意の判定providerで、`kioku.decisions`の既存APIから利用します。`kioku.typesafe:*`と`/kioku-typesafe-key`はTypeSafe専用です。

接続先の既定値は `~/Library/Caches/laya-coreml/worker.sock`。DSHはNodeのUnix domain socketから直接接続します。HTTPサーバーや`laya-call`の子プロセスは使いません。Python、モデル、常駐workerの管理は利用者が行います。

## 既存workerの更新

必要なのはApple Silicon上で既に使えるLaya-CoreML環境と、配置済みのモデルです。追加のNode依存はありません。通常起動ではモデルを取得せず、`local_files_only=True`を使います。Python／モデルの初期導入は既存のLaya手順を使ってください。

同梱の `scripts/laya-worker.py` が保守対象のworkerソースです。従来のversion 1 `health`／`predict`を残し、`preflight`／`predict_strict`を追加しています。既存workerを自分で停止してから、パッケージまたはリポジトリのルートで更新してください。稼働中ソケットを新しいworkerが削除することはありません。

```bash
mkdir -p ~/.local/bin
install -m 755 scripts/laya-worker.py ~/.local/bin/laya-worker.py

# laya_coremlをインストール済みのPython環境で実行する。
# pipxを使っている場合は、その環境のPythonを指定する。
LAYA_MODEL="$HOME/.local/share/laya-coreml/ane" \
LAYA_SOCKET="$HOME/Library/Caches/laya-coreml/worker.sock" \
python ~/.local/bin/laya-worker.py
```

プロセス管理ツールを使っている場合も、更新と再起動はその既存の管理方法で行います。DSH起動、plugin unload、status/probeはworkerを起動・停止しません。

起動時に推論用ファイル、tokenizer、校正設定、Laya実装、worker実装、依存バージョン、実行環境をハッシュし、ロードとwarmupの前後で一致を確認します。`READY`後に接続できます。モデルファイルは稼働中に変更せず、更新時はworkerも明示的に再起動してください。

## Jev / Layaを切り替える

拡張workerを起動したら、DSHのコマンド入力欄で実行します。通常はYAML編集、モデル名やfingerprintの転記、DSHの再起動は不要です。

```text
/kioku-decisions use laya
/kioku-decisions use jev
/kioku-decisions status
```

`use laya`は既定のsocketからモデルとfingerprintを自動取得し、既知解のprobeが通ってから切り替えます。`use jev`は登録済みTypeSafeキーを使ってprobeします。検査中は元のproviderを使用し、失敗・キャンセル・保存失敗では選択を変えません。probeには検査用の推論呼び出しが含まれます。

選択はプロジェクトと `typedDecisions` の基本設定に対応付けてKiokuko DBへ保存し、次のリクエストから使用します。再起動後も復元します。進行中・再開中の論理リクエストは元の設定・実体を維持します。基本設定を変更した場合は、その設定に対応する選択を使用します。別のDSHプロセスが先に選択を変更した場合は上書きせず、再起動して新しい選択を読み込みます。

```text
/kioku-decisions use nimble
/kioku-decisions use default
/kioku-decisions probe
```

Nimbleには接続先・モデルの事前設定が必要です。`use default`はプラグイン設定のproviderとmodeに戻します。`probe`は現在の選択を検査し、`status`はsocketやAPIへ接続しません。引数なしの `/kioku-decisions` でも選択肢を確認できます。

旧workerが `preflight` / `predict_strict` に未対応なら、更新方法を表示して切り替えを止めます。DSHがworkerを自動更新・起動することはありません。

### 設定ファイルを使う場合

コマンドを使わずLayaを既定にする場合は、次だけをプラグインの既存configへ追加します。

```yaml
typedDecisions:
  mode: auto
  provider: laya-coreml
```

初回のprobeまたはリクエスト開始時に実体を自動取得します。取得できなかったリクエストは既存のfallbackへ戻り、後から同じリクエストの実体を書き換えません。

接続先や受理方針を変更する場合だけ、optional設定を追加します。

```yaml
typedDecisions:
  mode: auto
  provider: laya-coreml
  laya-coreml:
    socketPath: ~/Library/Caches/laya-coreml/worker.sock
    timeoutMs: 5000
    acceptance:
      minProbability: 0.9
      minMargin: 0.2
```

`~`はシェルなしで展開し、相対パスは登録リポジトリルート基準で解決します。解決済み接続先、モデル、fingerprint、受理方針を論理リクエストに固定します。YAMLを変更した場合はDSHを再起動してください。コマンドでの切り替えには再起動不要です。

`model`と`runtimeFingerprint`を明示する高度な設定も引き続き使えます。その場合は自動検出結果と一致することを要求し、不一致を自動修正しません。固定値の取得が必要な場合だけ、リポジトリまたはパッケージのルートで `node scripts/smoke-laya-coreml.mjs --live --print-config` を実行します。リポジトリでは先に `npm run build` が必要です。

workerのモデルや実装を更新した後は、`/kioku-decisions use laya` を再実行すると新しい実体を検査・採用します。古いリクエストの実体は変更しません。YAMLに明示した固定値がある場合は、その制約の更新が必要です。

GPU版は配置済みモデルへ `LAYA_MODEL` を変更してworkerを再起動し、`use laya`で選び直します。対応識別名は `aac6fef/laya-multilingual-coreml`（1024 tokens）と `aac6fef/laya-multilingual-coreml-ane`（96 tokens）。実際のshapeとモデル設定を起動時に照合します。

## 入力と受理の制限

一回の厳密操作は一質問、最大32選択肢（棄権候補を含む）。トークン上限には質問・選択肢・マーカー・根拠の全体が入ります。全体が収まっても、上流前処理が選択肢や質問prefixを短縮する場合は拒否します。予約mask表記を含む入力も拒否します。自動要約・根拠末尾の削除は行いません。

`preflight`は完全な入力から構築したtoken IDs／marker位置を実際のprepare／collate結果と比較し、推論しません。`predict_strict`でも同じ検査を再実行します。長い記憶や計画レビュー、圧縮では容量拒否が多くなる可能性があります。容量不足・入力不正だけでworker全体を利用不能にしません。

Layaのchoice confidenceはエントロピー由来なので使わず、最大確率と二位との差で受理します。確率の4桁丸めを考慮し、最大確率から0.00005、差から0.0001を引いても閾値を満たす場合だけ選択します。同率・明示棄権・低スコアは既存の`abstained`へ変換します。`action.act_probability`は承認や実行許可ではありません。閾値0.9は正答率90%を意味しません。

記憶再利用では一件分の完全な根拠ごとに評価します。圧縮は全partがpreflightを通ってから対象batchの推論を開始します。readinessの検査用推論は別です。Layaの失敗は既存workflowのfallbackに戻るため、本体の別モデルへの送信までローカルになるわけではありません。Lispはhostの共通判定サービスを利用し、Lisp worker自体にはソケット権限を追加しません。

## 通信契約

1フレームは **4-byte unsigned big-endianのpayloadバイト長 + UTF-8 JSON**。改行やEOFでは区切りません。サーバーは同一接続内の複数操作に対応しますが、DSHは1操作1接続で終了します。フレームの上限は `1024 * 1024` bytes、DSHの要求・応答はenvelope込みで256 KiB以下です。

```json
{
  "version": 1,
  "op": "preflight",
  "model": "aac6fef/laya-multilingual-coreml-ane",
  "expectedRuntimeFingerprint": "sha256:<実際の値>",
  "budgetMs": 5000,
  "state": "The count is three.",
  "questions": {
    "count": {
      "type": "choice",
      "instructions": "Which count is stated?",
      "criteria": {"three": "Three", "one": "One", "unknown": "Unknown"}
    }
  }
}
```

`predict_strict`も同じ要求形です。healthは `{"version":1,"op":"health"}`。healthには対応operationsとruntime（model、runtimeFingerprint、limits）が入り、厳密操作の成功応答にも同じruntimeを付けます。preflightは`input_tokens`、predict_strictは従来の`result`と`server.predict_ms`を返します。`predict_ms`は秒差に `* 1000` を掛けたworker内時間で、DSH全体の往復時間ではありません。

| worker code | DSH側 |
|---|---|
| `too_large` | `DECISION_TOO_LARGE` |
| `invalid_request` / `invalid_state` / `invalid_questions` / `invalid_input` / `reserved_token` | `DECISION_INVALID_INPUT` |
| `unsupported_version` / `invalid_operation` / `unsupported` / `runtime_mismatch` | `DECISION_UNSUPPORTED` |
| `timeout` | `DECISION_TIMEOUT` |
| `busy` / `unavailable` | `DECISION_UNAVAILABLE` |
| 不正な成功応答・フレーム | `DECISION_MALFORMED_RESPONSE` |

親キャンセルは`DECISION_CANCELLED`。接続不在・拒否・権限不足は`DECISION_UNAVAILABLE`です。期限は接続・送受信全体に適用し、workerもロック待ち後に期限を確認します。クライアントが切断しても開始済みのCore ML推論は継続し得ます。結果を破棄し、再送しません。

## 検証と切り戻し

```bash
npm run typecheck
node scripts/run-tests.mjs tests/dsh/unit/decisions
npm run test:laya-worker
npm run build
node scripts/smoke-laya-coreml.mjs --live
```

smokeは既知解、容量拒否、実体不一致、legacy noul互換を確認します。fake tokenizerの成功を実モデルの非切り詰め確認とは扱いません。実機未配置のCIでは実機検証を実行しません。英語・日本語の品質やP50/P95などの性能比較は別評価です。

切り戻しは `/kioku-decisions use jev` または `/kioku-decisions use nimble` で行い、新しい論理リクエストから適用します。旧Laya結果と設定は残します。workerを止めてもJev/Nimbleの利用に影響しません。Layaを知らない旧バイナリへのダウングレード互換は保証しません。
