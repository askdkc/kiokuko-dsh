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
node scripts/evaluate-answer-review.mjs
node scripts/evaluate-answer-review.mjs --live --provider jev
node scripts/evaluate-answer-review.mjs --live --provider laya
```

実モデル評価は明示的な `--live` が必須です。Jevは環境変数 `TYPESAFE_API_KEY`、Layaは起動済みのworkerを使います。異なるソケットは `--socket PATH` で指定します。既存の資格情報ファイルを読み回ったり、workerを起動・交換したりしません。出力保存には `--output PATH` を使えます。

引数なしの評価は固定応答を使い、ホストの証拠抽出からproviderの応答解析・集計までをオフラインで検証します。モデルの精度を測るものではありません。`npm run test:evaluation:answer-review` はビルド後にこれを実行します。`--config PATH` は既存の `typedDecisions` 設定形式のJSONを読み、`--provider` と矛盾する設定を拒否します。`--repetitions N`（既定1）、`--seed N`（既定0）、`--warmup N`（既定0）で試行条件を固定できます。ウォームアップは集計に含めません。オフラインではLaya v1の固定応答を使います。

評価レポートは、受理前の選択肢・確率・受理条件と棄権理由を質問別に記録します。現在のv3は失敗試行を含む率と完了例だけの率を区別します。過去のv2は完了例だけの集計です。元の本文・資格情報は診断情報に保存しません。Laya v1では内部切り詰めと実モデルfingerprintを検証できず、`unverified_v1` のままです。strictの `strict_preflight` は全質問のpreflightと評価が成功した場合だけ記録します。

日英の同じ正例・誤答・根拠不足を使い、誤指摘率（非finding正解のうちfindingを返した割合）、検出率（finding正解のうちfindingを返した割合）、棄権率、評価時間を言語ごとに報告します。失敗したケースを正解に算入しません。これは小規模な固定データの測定で、製品全体の精度・費用・速度の証明には使いません。nativeテストのmock結果と実モデルの結果、ローカル検証とリモートCIは別の証拠です。

## 2026-09-22 のローカル測定

起動済みLaya v1 workerで上記8ケース（各言語4件・12判定項目）を実行しました。既定の `minProbability: 0.9 / minMargin: 0.2` のまま、日英とも全項目が棄権となりました。誤指摘率0%、検出率0%、棄権率100%であり、この測定で評価機能の有効性は確認できていません。平均追加時間は日本語924.5 ms、英語385.75 msでした。日本語を先に実行しており、最初の処理時間を含むため、言語別性能の比較には使えません。v1の内部切り詰め・実モデルfingerprintも未確認です。[Layaの測定結果](evaluations/answer-review-2026-09-22-laya.json)。

Jevは実行環境に `TYPESAFE_API_KEY` がなく、APIへ送信していません。精度・時間は未測定です。[Jevの未測定記録](evaluations/answer-review-2026-09-22-jev.json)。資格情報が利用できる環境で同じコマンドを実行してください。

## 主張単位のgrounding（明示設定）

`typedDecisions.groundingReview` の省略／`mode: legacy` は従来の四択を維持します。
新経路はまずshadowで測定してください。以下の数値は評価の再現例であり、推奨閾値ではありません。

```yaml
typedDecisions:
  provider: laya-coreml
  groundingReview:
    mode: shadow
    policyVersion: grounding-pairs-v1
    minProbability: 0.60
    minMargin: 0.25
```

`shadow` は従来レビューと並行して新分類を記録します。新分類は再検討を発火しませんが、従来項目のfindingは従来どおり発火します。
`candidate` は従来grounding項目を置き換え、新分類のcontradictedを原本再確認候補へ集約します。request_fit／verificationは維持します。
Layaのgrounding専用受理条件はproviderの分類結果を棄権へ変換する前に適用します。記憶・スキル等の共通閾値は変えません。
別providerでは専用確率閾値を適用できないため、そのproviderの受理条件を使います。

主モデルには、ツールに基づく事実の段落に `[tool-call:正確な呼出ID]` を付けるよう指示します。
イベントを直接指定する `[tool-result:イベント番号]` も解釈します。未参照・複数参照・同一IDの重複結果は保留します。
参照は比較する証拠の指定であり、対象・revision・時点の一致を保証しません。その意味判断は原文・call情報とともに分類器へ渡します。
段落を意味要約せず、数値・否定・条件・順序を保持します。対象の分かる構造化情報がない自由形式ログを、終了コードやSHAの確定情報へ変換しません。
ホストの切断フラグや入力上限超過は保留し、ログを切り詰めて送信しません。v1 worker内部の切断は依然未確認です。

新分類は `supported / contradicted / unknown`。supportedは主張全体への直接の根拠が必要です。
unknown（根拠不足・関係不明・曖昧・低確信）だけでは自動再検討しません。分類器の指摘は正答認定に使いません。
再検討では既存の原本だけを使い、ツール一覧を空にし、nativeのtools/pre-executeでも呼出をブロックします。
追加確認や副作用が必要なら新しいユーザー依頼を使います。再検討一回、取消、再起動時の再送禁止は維持します。

版・質問・選択肢・順序・入力・原本digest・受理設定はbatch／固定設定に含み、既存キャッシュで区別します。
進行中runの設定は変更しません。切り戻しは次のrunから `mode: legacy`、または `answerReview.mode: off` を指定します。

## 評価レポートv3

v3のdetectionRate／falseFindingRateは、正解ラベルのある失敗試行も分母へ含めます。
完了例だけの率はcompletedDetectionRate／completedFalseFindingRate。allTrialConfusionはfailure列を持ちます。
矛盾→整合、根拠不足→整合、クラス別誤指摘、失敗率を別掲します。保留率は完了例の指標です。
対訳／言い換えはgroupIdでまとめ、群単位bootstrapの区間と独立群数を示します。
費用と主モデルの再確認回数は値が供給されない場合nullで、固定分類器評価から推定しません。

```sh
node scripts/evaluate-answer-review.mjs --dataset fixtures.json --split tune --input full --question current --output /tmp/current.json
node scripts/evaluate-answer-review.mjs --dataset fixtures.json --split tune --input paired --question focused --choices focused --output /tmp/paired.json
node scripts/evaluate-answer-review.mjs --live --provider laya --dataset fixtures.json --split final --config settings.json --output /tmp/final.json
```

datasetは配列で、各行は `id, groupId, split: tune|final, expected: [request_fit, grounding, verification], ja: [task,answer,evidence|null], en: [task,answer,evidence|null]`。
ラベルは従来のsatisfied／finding／not_applicable／abstainで、新三択のsupported／contradictedは集計時に対応付けます。
新三択にnot_applicableを強制した例はunknownへ対応します。正解の意味を変えて検出率を上げません。
同じgroupIdをtuneとfinalにまたがせる入力は拒否します。既定4事例は調整用のみで、finalには外部datasetが必要です。
inputとquestionを一度に変えず、閾値はconfigだけで変えて比較します。paired評価は一つの明示参照段落だけを対象にし、複数段落を黙って最初の一件に縮めません。
生確率・受理理由・入力digest・実装artifactDigestを保存します。元36件の測定は今回の実装による再測定ではありません。

質問文は `--question`、選択肢は `--choices current|focused`、入力は `--input` で独立に切り替えます。focusedの質問文だけ変える場合はchoices=currentを維持してください。
段落全体が `exitCode=N [tool-call:ID]`／`isError=true|false [tool-call:ID]` という独立したリテラルの主張である場合だけ、対応したホストイベントの型付きメタデータと比較できます。不一致だけを決定的矛盾とします。引用・否定・例示・自然文の一部に同じ文字列があっても、この判定を適用しません。ツール本文のexit文字列はメタデータへ昇格しません。

## 添付された36件の位置付け

`laya-grounding-evaluation-2026-10-03.zip` の18種類・日英36件を、原文を保った[調整用fixture](../tests/fixtures/answer-review/laya-grounding-tune.json)に取り込みました。一般的な比較依頼だけを追加し、全群をtuneに固定しています。元資料にはnativeのcall ID、引数、型付き結果がないため、これらを実行証拠として捏造しません。参照のないpaired入力は保留となります。主張への参照追加は別の実験条件として、由来を記録したfixtureで評価してください。

モデルは `convaiinnovations/laya-multilingual`、revisionは `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67`。参照コードの `a2ea52e449af946397afd9cd256307990ca4135e` と今回の変更前HEADは同一です。[ZIPの再集計記録](evaluations/laya-grounding-2026-10-03-archive.json)にはファイルdigest、元集計、生確率の再集計、差分を残しています。

確率0.60／差0.25の元集計は以下です。fullとcompactを混ぜて比較しません。

| 質問・選択肢 | 入力 | 矛盾検出 / 12 | 誤指摘 / 24 |
| --- | --- | --- | --- |
| broad4（現行grounding） | compact | 0 | 0 |
| focused3_new | compact | 8 | 8 |
| focused2_user（旧二択） | compact | 4 | 4 |
| focused3_new | full | 3 | 2 |
| focused2_user | full | 4 | 3 |

生確率だけを現在の受理条件で再集計すると、focused3_new compactの誤指摘は9件です。根拠なしの `no_evidence` 群を外部で保留に置き換えると、全choice比較の元混同行列に一致します。元集計スクリプトがZIPにないため、そこで実際に使った処理は未確認です。この差は分類器と外部保留の区別として記録し、特定事例の例外処理を実装へ追加しません。旧二択compactの誤指摘4件は全て根拠不足です。

```sh
# 同じgrounding項目だけを比較し、質問・選択肢・閾値を一つずつ変更する
node scripts/evaluate-answer-review.mjs --dataset tests/fixtures/answer-review/laya-grounding-tune.json --dimension grounding --output /tmp/baseline.json
node scripts/evaluate-answer-review.mjs --dataset tests/fixtures/answer-review/laya-grounding-tune.json --dimension grounding --question focused --output /tmp/question-only.json
node scripts/evaluate-answer-review.mjs --dataset tests/fixtures/answer-review/laya-grounding-tune.json --dimension grounding --choices focused --output /tmp/choices-only.json
```

これらは既定ではオフライン契約検証です。`--live --provider laya` と起動済みworkerを使った別測定だけが変更後のモデル評価になります。今回のZIPは新実装、CoreML版との数値一致、主モデルの再確認回数、全体遅延・費用を検証するものではありません。

## 変更後のローカル実モデル測定

起動済みstrict CoreML multilingual workerで、確率0.60／差0.25、各条件36件を測定しました。[全9条件の生確率・集計](evaluations/answer-review-grounding-2026-10-03-coreml.json)にruntime fingerprint、入力・実装digest、失敗を含む母数を保存しています。ZIPのFP32モデルと同一の数値・重みだとは確認していません。

対照実験では、全主張へsynthetic call IDの参照を追加した同一fixtureを使っています。以下のfullは現行コードの全文包装、pairedは新しい主張・根拠包装です。元ZIPのfull／compactの完全再現ではありません。

| 入力 | 質問 | 選択肢 | 矛盾検出 / 12 | 誤指摘 / 24 |
| --- | --- | --- | --- | --- |
| full | current | current | 0 | 0 |
| full | current | focused | 0 | 0 |
| full | focused | current | 0 | 0 |
| full | focused | focused | 0 | 0 |
| paired | current | current | 0 | 0 |
| paired | current | focused | 2 | 3 |
| paired | focused | current | 0 | 0 |
| paired | focused | focused | 2 | 2 |

全条件で36件が完了し、推論失敗とstrict入力超過は0件でした。paired＋focused質問＋focused三択は矛盾9/12件、根拠不足7/12件をsupportedと判定しています。これは採用不可です。ゼロ誤指摘の他条件も検出率0%で、改善とは扱いません。参照を追加していない原文主張の現行全文包装でも検出0件でした。

同じ入力を再生成してpaired条件を実行する例です。設定JSONはこの評価プロセスだけに渡し、稼働中プラグインの共通閾値は変更しません。workerの起動・差し替えは行いません。

```sh
python3 - <<'PY'
import json
cases = json.load(open('tests/fixtures/answer-review/laya-grounding-tune.json'))
for case in cases:
    for language in ['en', 'ja']:
        case[language][1] += ' [tool-call:synthetic]'
    case['source']['transformation'] = 'Generic task and explicit synthetic tool-call citation added; original claim/evidence otherwise unchanged. Native event pairing is synthetic.'
with open('/tmp/grounding-cited-tune.json', 'w') as output:
    json.dump(cases, output, ensure_ascii=False)
settings = {'provider': 'laya-coreml', 'groundingReview': {'mode': 'candidate', 'policyVersion': 'grounding-pairs-v1', 'minProbability': .60, 'minMargin': .25}, 'laya-coreml': {'acceptance': {'minProbability': .60, 'minMargin': .25}}}
with open('/tmp/grounding-evaluation.json', 'w') as output:
    json.dump(settings, output)
PY
node scripts/evaluate-answer-review.mjs --live --provider laya --config /tmp/grounding-evaluation.json --dataset /tmp/grounding-cited-tune.json --dimension grounding --input paired --question focused --choices focused --output /tmp/grounding-paired.json
```

input・question・choicesの一つだけを変えて対照条件を実行します。閾値だけの比較では同じ入力・質問・選択肢を保ち、設定JSONの受理値だけを変えます。事後に良かった閾値を最終評価へ流用しません。

したがって、新経路は明示設定の実験機能とし、既定へは昇格しません。単一段落は保守的な比較単位であり、意味的に一つの主張への分解、自由形式ログの対象・revisionの一致、主モデルによる候補の棄却率は未検証です。Layaの質問変更だけで品質改善が成立したという結論は出しません。実行の型付き事実の限定判定、原本参照、保留、再実行防止を先に利用し、意味分類はshadowで追加検証します。

## 段階導入の受入基準

この変更では既定をlegacyに保ちます。先に単体・full/core native統合・配布物の検証を通し、次にshadowで記録を集めます。candidateを既定へ昇格する前に、閾値を凍結した独立120群以上（各正解クラス40群以上）の最終評価を行います。対訳・言い換え・再推論は同じ群に束ね、既に結果を見た18群は含めません。

採用の事前条件は、全試行で矛盾検出率50%以上、非矛盾の各クラスで誤指摘率5%以下、矛盾→整合・根拠不足→整合が各5%以下、完了率99%以上です。同じ群単位でbaselineとの差とbootstrap区間を比較します。検出率の増分の95%区間が0をまたぐ場合は追加検証へ回し、保留を増やしただけの候補は採用しません。対象・runの取り違え、切断の見逃し、再確認時のツール実行は一件でも不採用です。

実運用に近い同じ主モデルの対照試験では、不要な再確認が100依頼あたり5回以下、費用と依頼全体のp95遅延がbaselineの1.2倍以下を条件とします。providerだけの推論時間で代用しません。これらが未測定、データ不足、境界条件の扱いが曖昧ならshadowを継続します。指標の違反はcandidate導入を中止し、legacyへ戻します。

追加学習は必須ではありません。質問・入力の変更でこの条件を満たさなければ、同一対象の支持・矛盾・不足、古いrevision、範囲違い、途中切断、否定、複数主張、証拠内命令を含む群を収集します。教師ラベルは原本を人手確認し、群単位の学習・調整・未使用評価を固定します。閾値変更のみ、追加学習、Layaを候補提示へ限定する構成を同じ最終条件で比較します。実行可否や正答認定をLayaへ委ねる変更は含めません。
