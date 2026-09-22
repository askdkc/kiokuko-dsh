# 回答の再検討 / Answer review

通常版とmodular coreの通常実行で、最初の回答を表示してから評価します。指摘があれば同じ主モデルが一度だけ再検討します。設定を省略しても有効です。既定値は次のとおりです。

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

無効にする場合は `answerReview.mode: off` を指定します。評価providerは、その論理リクエストに固定された `typedDecisions` のJev／Laya／Nimbleです。選択したproviderが利用できない場合は評価をスキップし、元の回答で終了します。別providerへの自動切替はありません。`budgetMs` は評価の上限（1〜30,000 ms）です。評価には追加推論が発生し、指摘のある場合には主モデルの追加ターンも発生します。主モデルによる再検討の実行時間は評価予算に含みません。

## 評価する内容

依頼との一致、ホストが記録したツール結果との矛盾、実行・検証結果の誇張を、それぞれ `satisfied / finding / not_applicable / abstain` で判定します。総合点は付けません。必要な根拠がない項目はホスト側でも評価不能として扱い、指摘には採用しません。

入力は現在の依頼、表示された回答の全文、同じrunの現在のnative turnに属するツール結果です。別タスク・別セッションの履歴は渡しません。回答や根拠が入力容量を超えた場合は切り詰めずにスキップします。既存の秘密情報検出で入力が拒否された場合も送信しません。

Layaの通常v1 workerは内部の入力切り詰めとモデルfingerprintを確認できません。結果は `unverified_v1` の見直し候補です。strict workerは全質問のpreflightが通ってから評価します。Jev／Nimbleでもスコアや受理は正しさの保証ではありません。分類器の出していない問題説明は生成せず、該当項目と回答・根拠のイベント参照だけを再検討の手掛かりとして渡します。

## 継続と終了

`assistant/message` と正常な `turn/end` が揃った後、非同期workerが評価します。終了フックで推論を待ちません。評価中はrunの終了確定を保留します。失敗・タイムアウト・棄権では元の回答で終了します。

Enno、Deep、子エージェント、実行方式の選択中、取消・失敗・確定済みのrunは対象外です。修正回答は再評価しません。再検討は元のrun・依頼・モデル設定・capability catalogを維持し、Akinatorやモデル選択を再実行しません。権限と検証条件も引き継ぎます。

再検討の送信前にSQLiteで1回分の枠を確保します。保存済みのメッセージdigest・run・session・catalogが一致する内部メッセージだけを継続として受け入れます。送信例外や確認期限切れでは自動再送しません。新しいユーザー入力、停止、セッション破棄は評価と未送信の再検討を取り消します。再起動後はnative sessionを読み込んだ時点で記録済みの境界から終了処理だけを復旧し、推論や送信を再実行しません。

migration 025にはrun/session、回答イベント・入力digest、モデル名、評価状態と送信状態を保存します。回答・根拠の本文や資格情報は重複保存しません。元の本文はDSHの履歴にあります。

## 状態確認と検証

`/kioku-decisions status` の `answerReview` に設定、`evaluating`、`reconsidering`、`finished`、`skipped` と理由を表示します。`no_findings` は指摘が採用されなかったという意味で、正答認定ではありません。`abstained`、`timeout`、`delivery_uncertain`、`restart_no_retry` などを区別します。

```sh
npm run typecheck
npm run test:answer-review
KIOKUKO_REQUIRE_DSH_NATIVE=1 \
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" \
npm run test:answer-review
npm run build
node scripts/evaluate-answer-review.mjs --live --provider jev
node scripts/evaluate-answer-review.mjs --live --provider laya
```

実モデル評価は明示的な `--live` が必須です。Jevは環境変数 `TYPESAFE_API_KEY`、Layaは起動済みのworkerを使います。異なるソケットは `--socket PATH` で指定します。既存の資格情報ファイルを読み回ったり、workerを起動・交換したりしません。出力保存には `--output PATH` を使えます。

日英の同じ正例・誤答・根拠不足を使い、誤指摘率（非finding正解のうちfindingを返した割合）、検出率（finding正解のうちfindingを返した割合）、棄権率、評価時間を言語ごとに報告します。失敗したケースを正解に算入しません。これは小規模な固定データの測定で、製品全体の精度・費用・速度の証明には使いません。nativeテストのmock結果と実モデルの結果、ローカル検証とリモートCIは別の証拠です。

## 2026-09-22 のローカル測定

起動済みLaya v1 workerで上記8ケース（各言語4件・12判定項目）を実行しました。既定の `minProbability: 0.9 / minMargin: 0.2` のまま、日英とも全項目が棄権となりました。誤指摘率0%、検出率0%、棄権率100%であり、この測定で評価機能の有効性は確認できていません。平均追加時間は日本語924.5 ms、英語385.75 msでした。日本語を先に実行しており、最初の処理時間を含むため、言語別性能の比較には使えません。v1の内部切り詰め・実モデルfingerprintも未確認です。[Layaの測定結果](evaluations/answer-review-2026-09-22-laya.json)。

Jevは実行環境に `TYPESAFE_API_KEY` がなく、APIへ送信していません。精度・時間は未測定です。[Jevの未測定記録](evaluations/answer-review-2026-09-22-jev.json)。資格情報が利用できる環境で同じコマンドを実行してください。
