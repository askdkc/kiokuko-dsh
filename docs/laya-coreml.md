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

## 設定を取得する

リポジトリから使う場合は先に `npm run build` を実行します。配布パッケージにはビルド済みファイルが入っています。

```bash
node scripts/smoke-laya-coreml.mjs --live --print-config
```

この操作はhealth情報から貼り付け可能な設定を出力します。推論は行いません。既存のプラグイン設定内へ、他の設定を残して追記してください。

```yaml
typedDecisions:
  mode: auto
  provider: laya-coreml
  laya-coreml:
    socketPath: ~/Library/Caches/laya-coreml/worker.sock
    model: aac6fef/laya-multilingual-coreml-ane
    runtimeFingerprint: "sha256:<取得した64桁の値>"
    timeoutMs: 5000
    acceptance:
      minProbability: 0.9
      minMargin: 0.2
```

上のfingerprintは説明用です。実際には出力された値を使います。`~`は設定のスナップショット作成時に展開し、相対パスはDSHの登録リポジトリルート基準で解決します。解決済み接続先、モデル、fingerprint、受理方針を論理リクエストごとに固定します。モデル名は構成上の識別名であり、Hub revisionを証明しません。内容の識別にはfingerprintを使います。

```text
/kioku-decisions probe
/kioku-decisions status
```

`probe`は対応操作・実体を確認して既知解の質問を送ります。`status`は接続せず、設定と最後に確認した状態を返します。旧workerのhealth/predictが動くだけでは不足し、`DECISION_UNSUPPORTED`になります。未対応時に通常のpredictへ戻すことはありません。

GPU版を使う場合は `LAYA_MODEL` を配置済みの通常版へ変え、workerを明示的に再起動して設定を取得し直します。対応識別名は `aac6fef/laya-multilingual-coreml`（1024 tokens）と `aac6fef/laya-multilingual-coreml-ane`（96 tokens）。実際のshapeとモデル設定を起動時に照合します。

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

切り戻しは新しい論理リクエストに対する `provider: typesafe` または `provider: nimble` への変更で行います。旧Laya結果と設定は残します。workerを止めてもJev/Nimbleの利用に影響しません。Layaを知らない旧バイナリへのダウングレード互換は保証しません。
