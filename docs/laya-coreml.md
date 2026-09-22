# Laya-CoreML のローカル判定

Jev／TypeSafeが既定です。Nimbleも継続して使えます。Layaは手動で選ぶ任意の判定providerで、`kioku.decisions`の既存APIから利用します。`kioku.typesafe:*`と`/kioku-typesafe-key`はTypeSafe専用です。

接続先の既定値は `~/Library/Caches/laya-coreml/worker.sock`。DSHはNodeのUnix domain socketから直接接続します。HTTPサーバーや`laya-call`の子プロセスは使いません。Python、モデル、常駐workerの管理は利用者が行います。

## 起動済みのLayaを使う

`start-laya`でworkerが動いていれば、そのまま使えます。workerの差し替え、追加スクリプトの配置、モデル名やfingerprintの転記は不要です。

```text
/kioku-decisions use laya
/kioku-decisions status
```

DSHは既存ソケットへv1の`health`と`predict`を送り、既知解のprobeが通ってから選択を保存します。ソケットがなければ、ターミナルで`start-laya`を起動して再実行してください。未導入の場合だけ、[Layaの初期導入手順](Laya-CoreML-ja.md)を使います。

`/kioku-decisions install-laya`も、起動済みソケットが見つかればそれを検査して選択します。接続できない場合は起動・導入手順を案内します。Python、モデル、workerの自動インストールや再起動は行いません。

## Jev / Layaを切り替える

`start-laya`でworkerを起動したら、DSHのコマンド入力欄で実行します。通常はYAML編集、モデル名やfingerprintの転記、DSHの再起動は不要です。

```text
/kioku-decisions use laya
/kioku-decisions use jev
/kioku-decisions status
```

`use laya`は既定のsocketへ直接接続し、既知解のprobeが通ってから切り替えます。`use jev`は登録済みTypeSafeキーを使ってprobeします。検査中は元のproviderを使用し、失敗・キャンセル・保存失敗では選択を変えません。probeには検査用の推論呼び出しが含まれます。

選択はプロジェクトと `typedDecisions` の基本設定に対応付けてKiokuko DBへ保存し、次のリクエストから使用します。再起動後も復元します。進行中・再開中の論理リクエストは元の設定・実体を維持します。基本設定を変更した場合は、その設定に対応する選択を使用します。別のDSHプロセスが先に選択を変更した場合は上書きせず、再起動して新しい選択を読み込みます。

```text
/kioku-decisions use nimble
/kioku-decisions use default
/kioku-decisions probe
```

Nimbleには接続先・モデルの事前設定が必要です。`use default`はプラグイン設定のproviderとmodeに戻します。`probe`は現在の選択を検査し、`status`はsocketやAPIへ接続しません。引数なしの `/kioku-decisions` でも選択肢を確認できます。

通常のv1 workerには`preflight` / `predict_strict`を要求しません。既にその拡張を実装したworkerでは、厳密検査の経路も引き続き使えます。

### 設定ファイルを使う場合

コマンドを使わずLayaを既定にする場合は、次だけをプラグインの既存configへ追加します。

```yaml
typedDecisions:
  mode: auto
  provider: laya-coreml
```

初回のprobeまたはリクエスト開始時に接続を確認します。接続できなかったリクエストは既存のfallbackへ戻り、後から同じリクエストの設定を書き換えません。

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

通常のv1接続では、`status`に`protocol: "v1"`と`runtimeFingerprint: null`を表示します。`laya-rl-agent`は応答にあるモデル識別名です。workerが返すモデルパスやPIDをfingerprintの代用にはしません。DSHは設定とソケットの接続先を固定しますが、v1ではworker内部のモデル実体が変更されていないことまでは検証できません。

`model`と`runtimeFingerprint`を明示している既存の厳密設定は、引き続きその固定値を検証します。通常の`start-laya`へ切り替える場合はこの固定値を外し、プラグイン設定を読み直してください。固定値の不一致を理由に通常のv1へ自動で切り替えることはありません。

## 入力と受理の制限

一回の判定は一質問、最大32選択肢（棄権候補を含む）。DSHは根拠・質問・選択肢を省略せず送り、要求と応答を256 KiB以下に制限します。通常のv1にはtoken容量や切り詰めの検査APIがないため、worker内部の入力処理は検証できません。

拡張workerの場合だけ`preflight`と`predict_strict`でtoken容量・入力完全性・実体一致を検査します。`scripts/laya-worker.py`はこの任意の拡張の保守用ソースで、通常の接続には不要です。

Layaのchoice confidenceはエントロピー由来なので使わず、最大確率と二位との差で受理します。確率の4桁丸めを考慮し、最大確率から0.00005、差から0.0001を引いても閾値を満たす場合だけ選択します。同率・明示棄権・低スコアは既存の`abstained`へ変換します。`action.act_probability`は承認や実行許可ではありません。閾値0.9は正答率90%を意味しません。

記憶再利用では一件分の完全な根拠ごとに評価します。拡張workerでの圧縮は全partがpreflightを通ってから対象batchの推論を開始します。readinessの検査用推論は別です。Layaの失敗は既存workflowのfallbackに戻るため、本体の別モデルへの送信までローカルになるわけではありません。Lispはhostの共通判定サービスを利用し、Lisp worker自体にはソケット権限を追加しません。

## 通信契約

1フレームは **4-byte unsigned big-endianのpayloadバイト長 + UTF-8 JSON**。改行やEOFでは区切りません。サーバーは同一接続内の複数操作に対応しますが、DSHは1操作1接続で終了します。フレームの上限は `1024 * 1024` bytes、DSHの要求・応答はenvelope込みで256 KiB以下です。

```json
{
  "version": 1,
  "op": "predict",
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

healthは`{"version":1,"op":"health"}`です。v1のhealthは`version: 1`、`ok: true`、`status: "ready"`を返し、predictは`result`と`server.predict_ms`を返します。`predict_ms`はworker内の推論時間で、DSH全体の往復時間ではありません。

任意の拡張workerはhealthにoperationsとruntimeを追加し、`preflight` / `predict_strict`要求にモデル、期待fingerprint、残り時間を受け取ります。厳密操作の成功応答にも同じruntimeが必要です。

| worker code | DSH側 |
|---|---|
| `too_large` | `DECISION_TOO_LARGE` |
| `invalid_request` / `invalid_state` / `invalid_questions` / `invalid_input` / `reserved_token` | `DECISION_INVALID_INPUT` |
| `unsupported_version` / `invalid_operation` / `unsupported` / `runtime_mismatch` | `DECISION_UNSUPPORTED` |
| `timeout` | `DECISION_TIMEOUT` |
| `busy` / `unavailable` | `DECISION_UNAVAILABLE` |
| 不正な成功応答・フレーム | `DECISION_MALFORMED_RESPONSE` |

親キャンセルは`DECISION_CANCELLED`。接続不在・拒否・権限不足は`DECISION_UNAVAILABLE`です。期限はDSH側で接続・送受信全体に適用します。拡張workerではロック待ち後にも期限を確認します。クライアントが切断しても開始済みのCore ML推論は継続し得ます。結果を破棄し、再送しません。

## 検証と切り戻し

```bash
npm run typecheck
node scripts/run-tests.mjs tests/dsh/unit/decisions
npm run test:laya-worker
npm run build
node scripts/smoke-laya-coreml.mjs --live
```

smokeは起動済みworkerへの自動接続、既知解、noul互換を確認します。拡張workerの場合は容量拒否と実体不一致も確認します。fake tokenizerの成功を実モデルの非切り詰め確認とは扱いません。実機未配置のCIでは実機検証を実行しません。英語・日本語の品質やP50/P95などの性能比較は別評価です。

切り戻しは `/kioku-decisions use jev` または `/kioku-decisions use nimble` で行い、新しい論理リクエストから適用します。旧Laya結果と設定は残します。workerを止めてもJev/Nimbleの利用に影響しません。Layaを知らない旧バイナリへのダウングレード互換は保証しません。
