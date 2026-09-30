# 出典付きの事前推論索引

元記憶を保持し、回答に使える一つの事実（atomic）と、共通の対象で二つの元記憶を結ぶ説明（bridge）を別の記憶候補として保存します。生成本文、適用条件、出典抜粋を後のDSH requestへ直接渡します。生成・出典検査に成功しても `candidate / untrusted` のままです。

```yaml
memoryIndexReasoning:
  mode: active
  dailyCalls: 8
  maxInputBytes: 32768
  maxOutputTokens: 2048
  timeoutMs: 60000
```

互換パッケージと独立coreの両方に設定できます。既定値はactiveです。observeは生成・検査だけを行い、通常検索・注入へ生成物を出しません。offは追加生成と利用を止め、保存済みデータを保持します。設定ファイルの変更は再起動時に反映されます。下のmode操作はworkspaceに保存され、同じ設定ファイルでの再起動後も保持されます。ファイルの設定が変わると、その新設定を適用します。

`memoryRetrieval` の時間検索・related検索とは独立しています。索引の検索・注入に新たな生成モデル呼び出しはありません。既存の埋め込み検索や任意のmemoryReuse設定はそれぞれの規則に従います。

## 生成・費用

- 元記憶の保存と同じtransactionでrevisionを永続キューへ登録します。モデル送信はcommit後です。capture、Memory Review、Finalizerで共通の保存経路を使います。
- 同じworkspaceの元記憶だけを使います。派生記憶・外部Skill・保存除外・機密情報・supersede・矛盾feedbackを除外します。共通entityは型と正規化値が一致する場合だけ結合し、別名を推測しません。同じ本文や引用を二つの独立根拠として数えません。
- 抽出は元記憶4件まで、各4 factsまで。結合は10 pairsから3 bridgesまで。別の呼び出しで元本文との支持関係を検査し、supported以外を配信しません。モデル検査は独立した真偽検証ではありません。
- workspaceごとにUTC日次8呼び出しまで。抽出・結合・検査・結果不明の送信予約も数えます。単一ホスト内は同時1件、入力32 KiB、出力2,048 tokens、timeout 60秒です。入力容量が足りないものを切り詰めて送信しません。
- ジョブ予約時のadmitted native requestのprovider/model/context容量を固定します。不明なら待機します。代替モデルは選びません。新規・更新を優先し、残る予算で旧記憶を100件ずつ照合・登録します。
- 日次上限で未送信の段階は次のUTC予算枠で再開します。期限切れclaimは未送信なら回復します。送信後のtimeout・クラッシュは結果不明として保留し、自動再送しません。retryは明示的な再送で、追加費用が発生し得ます。
- provider内部の再送はDSH/provider設定に従い、workerの呼び出し数には含みません。

## 配信と失効

元記憶と生成物を別の検索候補枠で取得します。完全一致した元記憶を確保した後、bridgeを `min(3, floor(limit × 0.3))` 件・文字予算30%以内で選び、残りを元記憶とatomicで埋めます。生成物の本文・条件・出典は途中で切りません。収まらないものは見送ります。旧receipt v1/v2を読み取り、生成物には出典revision/hashとmanifestを束縛するreceipt v3を使います。

出典更新・削除・supersede・保存除外・矛盾feedbackで、生成物は検索と最終requestから除外されます。保存したmanifestとジョブの入力・検査判定は監査用に残ります。設定世代と索引世代をdeliveryの再利用判定へ含めます。生成後にverifiedへ変更しても、この索引の生成物としては配信しません。

## 操作

```text
/kioku-index-reasoning status --json
/kioku-index-reasoning mode active
/kioku-index-reasoning mode observe
/kioku-index-reasoning mode off
/kioku-index-reasoning backfill
/kioku-index-reasoning retry JOB_ID
```

現在のnative sessionに結び付いたworkspaceを操作します。statusは保存件数、キュー状態、段階・保留理由・未採用候補数、当日の呼び出し数、生成時間、報告tokenを表示します。本文、provider credential、生の例外は出しません。未報告usageが一件でも含まれる集計はnullです。保存件数は利用可能件数を保証せず、利用時に出典を再検査します。backfillは上限100件の照合を行い、有効なadmitted model bindingが得られるまで送信しません。

## 検証と評価

```sh
npm run test:index-reasoning
npm run test:evaluation:index-reasoning
```

専用テストにnative DSH配信確認を含みます。CIは固定native runtimeを必須にします。通常テストにも専用回帰ケースを含めます。

評価は同じ質問・モデル・8,000文字・2,048出力tokensで、current / atomic / atomic+bridge / bridge-metadata-onlyを比較します。設定なしでは固定fixtureで配信・根拠到達・Recall・重複・検索時間・生成呼び出し数だけを確認し、実モデル品質をunmeasuredとします。実モデルでの改善率は未測定です。論文の改善率をKiokukoの成果とは扱いません。

実モデル評価を明示的に行う場合:

```sh
npm run test:evaluation:index-reasoning -- --config /absolute/path/evaluation.json
```

```json
{
  "allowRemote": true,
  "llm": {
    "baseUrl": "https://YOUR-ENDPOINT/v1",
    "model": "PINNED-MODEL-ID",
    "revision": "PINNED-REVISION",
    "contextWindow": 131072,
    "apiKeyEnv": "INDEX_EVALUATION_API_KEY"
  }
}
```

chat/completions互換endpointを使い、model応答のID変更・redirect・不完全応答を拒否します。実モデル生成と16回答試行には費用が発生します。固定QAの回答評価は期待語の一致であり、一般的な真偽・有用性の証明ではありません。既定のbridge上限も初期設計値で、最適性は未実証です。

migration 030を追加し、過去migrationと元記憶を変更しません。ソース、配布物、稼働中DSHへの反映は別々に確認してください。ローカルbuildだけでは使用中プロファイルを更新しません。
