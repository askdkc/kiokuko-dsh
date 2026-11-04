# AgenticReplayログの不具合調査レポート

調査日: 2026年11月4日（JST）  
対象: `/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay`  
ブランチ: `main` / HEAD: `e48af320d78f3c807502e0801eb65a579f73d42e`

## 結論

記録済みログの破損は確認されなかった。確認できた主な問題は、**失敗理由をAgenticReplayへ引き継がない記録処理、保存済みモデルの推論強度メタデータ欠落、継続処理・完了基準の入力不一致**である。

実際にターンが停止した記録は2件あり、そのうち1件は同一Infronモデルへの6回の失敗で終わっている。ただし、元のエラーコード・メッセージ・HTTPステータスが記録されていないため、**最初のモデル失敗の根本原因はこのログだけでは確定できない**。もう1件も直前のツールは成功しており、例外の詳細が欠けている。

追加提示された `toolExposure ... session_failed` は、先行するエラーを受けてツール構成の変更を見送った結果である。警告を最初の失敗原因と判断する根拠はない。

推論強度の修正は調査開始前から作業ツリーで進行していた。調査中の変更を含む特定時点では関連89テストが通過したが、稼働中プロファイルへの反映や実サービスでの解消は今回確認していない。本調査では製品コードを変更していない。

## 対象と検証範囲

2026-11-04 **16:10:01〜16:10:02 JST** に各ログのmanifestとeventsを読み取り、以後はその範囲を固定した。全ディレクトリを同時に取得したスナップショットではない。記録中のC・Eには取得後のイベントを含めない。

| 記号 | run ID | イベント | 参照blob | 状態 | ツール失敗 |
|---|---|---:|---:|---|---:|
| A | `run_084d215cb10d4aa5ef61db26` | 1,310 | 149 | 完了済み | 19 |
| B | `run_fcbbfb4169971d07cd1a3cef` | 2,054 | 243 | 完了済み | 18 |
| C | `run_c9a67481283045a1a79b7e59` | 859 | 83 | 未完了・追記を観測 | 9 |
| D | `run_408764c7882abae195a63f26` | 411 | 39 | 完了済み | 2 |
| E | `run_96c9377e3f14debd31d650a8` | 147 | 15 | 未完了・追記を観測 | 0 |

合計4,781イベント、runごとの参照blob数の合計529件、JSONLと参照blobの合計276,791,887バイト。ツール結果554件中、`is_error=true` は48件。これには正常な権限制御、探索失敗、開発途中のテスト失敗も含まれるため、「製品不具合48件」を意味しない。

実施した検査:

- 全manifest・全イベントをローカルのAgenticReplay schemaで検証。記録側coreは0.1.12、検証側coreは0.1.9であり、同一バージョンでの公式検証ではない。
- UTF-8/JSON解析、JSONL末尾改行、0起点の連番、`causes` の既出イベント参照を確認。
- 各参照blobの存在・JSON解析・バイト数・SHA-256を照合。参照blobの不整合は0件。
- 完了済みA・B・Dのmanifest内のイベント数・blob数・イベントSHA-256を照合。すべて一致。
- 完了済みA・B・Dの物理blobはすべて参照され、物理blobのSHA-256も一致。`redactions.json` は3件ともJSONとして解析できた。任意の秘密情報を完全に除去できているかは未監査。
- ツールのcall/resultとモデルのrequest/responseをIDで照合。固定範囲では孤立したツール結果はなく、Eの最後のモデルrequestだけが応答待ち。未完了ログのため破損とは扱わない。

A・B・Dの `recording_complete=true` は記録処理の完了を示し、作業成功を示さない。Bには `payload_limit` によるモデルrequest本文の省略が20件ある。`missing_events=0` と「本文をすべて保持した」は別条件である。

## 1. エラー詳細が記録の途中で失われる【確定・優先度高】

Bの09:37:38〜09:37:57 JSTでは、`kiokuko-infron-c979e6cb / deepseek/deepseek-v4.1-flash:free` に6回リクエストし、毎回 `stop_reason=error`、空の `blocks` で終了している。5回のretryの後に `native_turn_failed` となった。入力・出力tokenはログ上0だが、これだけでサーバー未到達や無課金とは判断できない。

根拠: [B seq=3](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:4)、seq=8/13/18/23/28、[B seq=31](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:32)。

現行ソースに、詳細を落とす経路が3か所ある。

1. streamのfinishから `failure.code` を読むものの、記録するのは2種類のメモリ関連コードだけ。通常のproviderエラーのcode/message/statusをmodel.responseへ持ち越していない。[src/dsh/agenticreplay-recorder.ts:289](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-recorder.ts:289)、[src/dsh/agenticreplay-recorder.ts:378](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-recorder.ts:378)。
2. `agent/error` のフックはbindingだけを `nativeFailure` に渡し、元のerrorを渡していない。生成されるerrorイベントは固定の `native_turn_failed` のみ。[src/dsh/agenticreplay-hooks.ts:28](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-hooks.ts:28)、[src/dsh/agenticreplay-recorder.ts:476](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-recorder.ts:476)。
3. ハーネス本体は `diagnostic` を作成・保存するが、AgenticReplayの `harnessAction` はaction/phase/step等だけを転記し、diagnosticを除外する。[src/dsh/harness/factory.ts:27](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/harness/factory.ts:27)、[src/dsh/harness/factory.ts:94](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/harness/factory.ts:94)、[src/dsh/agenticreplay-recorder.ts:224](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-recorder.ts:224)。

Bの2回目のターン失敗は10:09:44 JST。直前の `coding_workflow_apply` は `is_error=false`、状態readyで返っており、その後にstep=59のturn errorがある。単に「直前のツールが失敗した」とは説明できない。[B seq=761](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:762)、[B seq=764](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:765)。

**判断:** 診断情報が失われる実装は確認できた。元の通信失敗・停止を引き起こした原因は未確定。記録不足と、元の不具合を区別する必要がある。

**修正候補:** 失敗時に安全なcode/status/requestIdと、長さ制限・秘匿処理を通したmessageを引き継ぐ。生の認証情報やHTTP本文の丸ごと保存は不要。通常のprovider拒否・stream例外・ツール成功後のagent例外で、元の診断が最終ログまで残ることを受け入れ条件にする。

## 2. 修正済みソースと当時のインストール版が一致していない【記録上確定】

Bでは作業リポジトリが0.2.43である一方、Webプロファイル内のpackageは0.2.41で、ハーネスの例外処理に汎用の `KIOKUKO_HARNESS_ERROR` が残っていた。この版の例外経路なら、ユーザー向け表示が「Kiokuko execution failed...」だけになる。ただしBを記録したプロセスのロード済みファイルidentityまでは、この検査結果だけでは証明できない。根拠: [B seq=42](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:43)、[B seq=204](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:205)。

同じログの後半には、インストール版0.2.44、旧sentinel件数0、rejection reason helperあり、という再確認結果もある。したがって、古い版が**現在も**インストールされているとは断定できない。ディスク上の更新確認と、既存プロセスの再起動・実行中コードの切替も別である。根拠: [B seq=1283](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl:1284)。

OpenCode adapterでHTTP拒否理由を捨てていた問題は、B内の回帰テストでも確認されている。期待する理由文がなく `HTTP 400` だけになる失敗がseq=998/1032にあり、現行ソースには理由の抽出・秘匿・上限処理がある。[src/dsh/models/vendor/opencode-adapter.ts:212](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/models/vendor/opencode-adapter.ts:212)。

ただし、そのテストの「image input非対応」は合成fixtureの値であり、B冒頭の実障害原因ではない。Bには別の画像・payloadサイズ・reasoning設定のprobeがHTTP 200になった結果もある（seq=576/586/602）。これらも元の6回と同一リクエストではないため、元の失敗を再現・解消した証拠にはしない。

## 3. 保存済みInfron/Nousモデルの推論強度が一覧へ届かない【過去の欠落を確認・修正進行中】

Cのseq=491/583では、保存済みモデルを再読込した後の推論強度一覧が、期待する `off/low/high/max` ではなく `undefined` になっている。InfronとNousの両方で失敗した。根拠: [C seq=491](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59/events.jsonl:492)、[C seq=583](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59/events.jsonl:584)。

HEAD版の `start()` は保存設定をそのまま公開し、古い行に不足する能力情報を補完していなかった。また `ModelsAdapter.listModels()` は所有モデルの保存行をそのまま返し、adapterが解決する `reasoning.efforts` へ変換していなかった。保存契約の `reasoningEfforts`、profileの `thinkingLevelMap`、UI側が読む `reasoning.efforts` は別の表現である。

調査時の既存変更には、保存済みInfron/Nous行のカタログ補完と、一覧で `resolveModel()` を通す処理がある。[src/dsh/models/service.ts:130](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/models/service.ts:130)、[src/dsh/models/service.ts:287](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/models/service.ts:287)、[src/dsh/models/service.ts:377](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/models/service.ts:377)、[src/dsh/models/profiles.ts:237](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/models/profiles.ts:237)。

Cのseq=685の `Models service stopped` はその途中のテスト実行で発生した別の失敗であり、元のUI症状の原因と同一視しない。調査中にもprofilesとテストが更新され、最終の限定テスト実行ではこの系統を含め89件すべて通過した。これは本調査による修正成果ではなく、並行変更を含む観測結果である。

**残る確認:** 古い保存設定を持つ実ユーザーが通常起動し、モデルを選び、推論強度を切り替えたときのUI・実際の送信・再起動後の保持。今回のテストはローカルfixtureによるもので、稼働環境の受け入れ確認ではない。

## 4. 完了基準IDの取り違えと継続入力の不一致【確定範囲と仮説を分離】

### 完了基準ID: 直接原因を特定

Aは `c-adopt` / `c-wire`、Cは `gateway-regression` をそのまま `task_completion.bind` に渡して失敗した。実際のcompletion側IDは `coding:<workflowId>:<criterionId>` である。

Aのstatus（seq=1001）が完全なIDを返した後、seq=1011/1017ではbindが成功している。Cもseq=443の失敗後、seq=453で成功した。これは基準そのものの消失を証明するものではなく、**2つのAPIのID表現を混同した呼出し**で説明できる。根拠: [A seq=985](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003456-kiokuko-dsh-infron-api-cannot-pick-thinking-reasoning-level-please-fix-it-084d215cb10d4aa5ef61db26/events.jsonl:986)、[A seq=1001](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003456-kiokuko-dsh-infron-api-cannot-pick-thinking-reasoning-level-please-fix-it-084d215cb10d4aa5ef61db26/events.jsonl:1002)、[A seq=1011](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003456-kiokuko-dsh-infron-api-cannot-pick-thinking-reasoning-level-please-fix-it-084d215cb10d4aa5ef61db26/events.jsonl:1012)、[C seq=443](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59/events.jsonl:444)、[C seq=453](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59/events.jsonl:454)。ソース: [src/dsh/task-completion.ts:192](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/task-completion.ts:192)、[src/dsh/task-completion-host.ts:57](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/task-completion-host.ts:57)。

### 継続入力: 拒否は確認、具体的な不一致フィールドは未確定

Bのseq=852/872で `dsh continued turn was reused with different bound input` が2回返っている。2回目は `evidenceRefs` にmessage参照を追加しているが、記録にはcached fingerprintや比較対象のnative object identityがない。

現行コードは同じ継続turnのfingerprint・nativeAgent・nativeSessionを比較し、不一致を拒否する。特定の未解決bindingだけを解消する例外経路もある。[src/dsh/host-adapter/admission.ts:756](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter/admission.ts:756)。

**仮説:** 継続中にrequest/context/evidence等が変わったか、native identityが変わった。どの比較で拒否されたかまでは確定できない。検証条件を弱める修正ではなく、比較項目ごとの差分理由と、同じ入力の再送・正当な継続の区別を観測できる診断が必要。

Lisp経路指定、prototype結果の確認前実行、Goal未定義、完了後の実行、Goal ID変更もログにある。これらは制御条件による拒否であり、すべてを製品クラッシュに分類しない。BのGoal ID変更拒否は `goalId` が安定したidentityであるという現行契約と一致する。

## 5. 追加提示されたtoolExposure等のログ

追加ログには日時・session IDがないため、A〜Eの特定イベントとの同一性は確認できない。以下は提示文と現行コードの照合結果である。

| ログ | 発生条件・意味 | 原因調査上の判断 |
|---|---|---|
| `auto:pre_step_missing_turn` | 入力claimにもcurrent recordにもturnがない | pre-stepの関連付けが未成立。コードはnative workerの経路へ返る。この警告自体はthrowしない |
| `auto:unbound:turn_record_missing` | `currentSession()` のrecordがない | ツール構成を変更せず返す。初期状態か、記録の紐付け不備かはこの1行では分からない |
| `auto:unbound:session_failed` | 既存recordの `failed` がtrue | `agent/error` の通知でtrueになるため、先行エラーの結果。警告を根本原因として扱わない |
| `registration_provenance_unavailable` | 外部・非所有ツールの削減理由欄に設定される固定値 | 動的なpackage登録失敗の検出結果ではない |
| `Session ID check: 503/503 ... 0 repaired, 0 failed` | セッションID検査で修復・失敗が0 | この検査の範囲では正常。モデル通信や全履歴の正常性を保証しない |
| DeepSeekのmodel listingが2件、skip 0 | 両経路でモデル一覧を読み込めた | 一覧取得の成功。生成リクエストの成功や推論強度対応は別 |

呼び出し順は `agent/error → item.failed=true → toolExposureがsession_failedを検出 → 元のtoolsを維持`。根拠: [src/dsh/host-adapter/session-observation.ts:108](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter/session-observation.ts:108)、[src/dsh/host-adapter/routing.ts:150](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter/routing.ts:150)、[src/dsh/host-adapter/routing.ts:229](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter/routing.ts:229)。

`pre_step_missing_turn` の根拠: [src/dsh/host-adapter/routing.ts:264](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter/routing.ts:264)。外部ツールの削減理由の固定値: [src/dsh/tool-exposure.ts:84](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/tool-exposure.ts:84)。ID検査の集計: [src/dsh/session-history-compatibility.ts:244](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/session-history-compatibility.ts:244)。

提示された3件のlean projectionは、すべて説明文1件を417バイト短縮している。82→82、82→82、80→80でツール数は不変、引数定義のバイト数も不変、task/phaseによる削除も0件。**この3行から「必要なツールが削られて失敗した」とは言えない**。80と82の差は別の入力surfaceの差であり、各projectionの削減ではない。

現在の警告出力はモードと理由だけで、session/run/turn/call IDを出していない。また理由ごとに重複出力を抑止する。別セッションが並行している場合、コンソール上の隣接行だけで因果関係を結ぶのは危険。[src/dsh/host-adapter.ts:469](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/host-adapter.ts:469)。

## 6. 記録の制限と、追加障害ではないもの

- Bのrequest本文省略20件は `payload_limit` と明示されている（seq=1423〜1632）。この範囲の完全な入力内容・秘密情報除去前の内容・HTTP送信を復元できない。
- A/Bのrequestには1 MiB超のblobがそれぞれ36/65イベントある。既定のshow上限やexport上限では閲覧・出力を拒否し得る。A/Bは既定8 MiB export入力上限も超える。これは制限と実データの差であり、保存データの破損を意味しない。[src/dsh/agenticreplay-files.ts:68](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-files.ts:68)、[src/dsh/agenticreplay-files.ts:116](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-files.ts:116)。
- `native_is_error=false` でも非ゼロ終了コードを基に `is_error=true` へ補正した結果が11件ある。失敗フラグの差は記録の誤りとは限らない。[src/dsh/agenticreplay-event-mapper.ts:135](/Users/dkc/Sites/Src/kiokuko-dsh/src/dsh/agenticreplay-event-mapper.ts:135)。
- B seq=84は検索コマンドの終了コード1、seq=612は `/tmp` からのES module依存解決失敗。これらを利用者のprovider障害と混同しない。
- AのUIテストはseq=1185で失敗し、その後seq=1273で成功している。開発中のRed/Greenを、未修正の障害件数へ単純加算しない。
- 元のログにはDSH 0.2.2-alpha.3 / Node v26.12.1が記録されているが、すべてのイベントにkiokuko-dshのcommitやロード済みpackage identityがあるわけではない。現行ソースの読み取りだけでは当時の全実装を証明できない。

## 検証結果と対応順

| 確認 | 結果 | 制約 |
|---|---|---|
| 固定範囲4,781イベントの構造・参照・hash検査 | 合格 | 未完了2runの最終manifest整合性は未検証 |
| `node scripts/run-tests.mjs tests/dsh/unit/opencode-stream-lifecycle.test.ts tests/dsh/unit/kiokuko-models-service.test.ts` | 89件成功、失敗/skip 0 | 16:13:34 JST開始。関連5ファイルの実行前後SHA-256一致。ローカル合成transportで検証 |
| `node scripts/run-tests.mjs tests/dsh/unit/tool-exposure.test.ts` | 38件成功、失敗/skip 0 | projectionの既存単体テスト。追加ログそのものの実セッション再現ではない |
| 実サービス再現、稼働中プロセス確認、全体verify、remote CI | 未実施 | 調査範囲を越える公開・インストール・実API再送は行っていない |

最初の限定テストはsandboxのlocalhost listen制限で失敗した。許可された環境での再実行中には、並行変更途中のoff送信形式の不一致が2件あった。その後、関連ソースの実行前後hashを固定して上記89件の成功を確認した。途中結果を最終版の不具合として残さない。

対応の優先順位:

1. **エラー詳細の記録経路を補う。** これが元の通信失敗と、ツール成功後の停止を区別する前提になる。
2. **実行中のpackage identityと元エラーを同じsession/turnで照合する。** 過去のディスク更新を現在のロード済みコードの証拠にしない。
3. **並行修正中のモデル能力伝達を通常のWeb利用経路で受け入れ確認する。** ローカル89件成功だけで稼働解消を宣言しない。
4. **継続binding・completion ID・toolExposureの診断を具体化する。** identity検査を緩めるのではなく、呼出し側が正しい次の操作を選べる情報を返す。

## 根拠ファイルと取得時点

イベント番号は0起点の `seq`。JSONLの行番号は `seq+1`。本文がblob参照の場合は、イベントの `$blob` が内容を一意に指定する。

- **A**: [20261104003456-kiokuko-dsh-infron-api-cannot-pick-thinking-reasoning-level-please-fix-it-084d215cb10d4aa5ef61db26](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003456-kiokuko-dsh-infron-api-cannot-pick-thinking-reasoning-level-please-fix-it-084d215cb10d4aa5ef61db26/events.jsonl)
  最終取得イベント時刻: `2026-11-04T06:53:26.000Z`（UTC） / events SHA-256: `c0d5842decc8e829d6d2ec126981dc12b198008a5effdcf9e7c1ec955e6613cb`
- **B**: [20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104003738-kiokuko-dsh-please-fix-this-konotanhashibaishimashitakiokuko-execution-failed-inspect-the-re-fcbbfb4169971d07cd1a3cef/events.jsonl)
  最終取得イベント時刻: `2026-11-04T06:53:25.993Z`（UTC） / events SHA-256: `ccbda6fdc68277e2d15b698e77a5b56970e36835787aef641c1e4f851ad4de61`
- **C**: [20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104065920-kiokuko-dsh-session-c9a67481283045a1a79b7e59/events.jsonl)
  最終取得イベント時刻: `2026-11-04T07:09:43.412Z`（UTC） / events SHA-256: `5137f2b2d0e704e2923b45da3275b5ca5b77a56f77176a75ad19b1e4708c3dc0`
- **D**: [20261104070125-kiokuko-dsh-read-only-investigation-in-users-dkc-sites-src-kiokuko-dsh-user-wants-infron-and-408764c7882abae195a63f26](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104070125-kiokuko-dsh-read-only-investigation-in-users-dkc-sites-src-kiokuko-dsh-user-wants-infron-and-408764c7882abae195a63f26/events.jsonl)
  最終取得イベント時刻: `2026-11-04T07:04:48.650Z`（UTC） / events SHA-256: `213d23f32fff2cf19e1ca69e65deeafa6aa1600d675a127ff5f7d761d3112530`
- **E**: [20261104070902-kiokuko-dsh-session-96c9377e3f14debd31d650a8](/Users/dkc/Sites/Src/kiokuko-dsh/.agenticreplay/runs/20261104070902-kiokuko-dsh-session-96c9377e3f14debd31d650a8/events.jsonl)
  最終取得イベント時刻: `2026-11-04T07:09:54.381Z`（UTC） / events SHA-256: `03d08a70e83ff11b16ce58f318376b895abf43a029a59133ae1206e1952e23e5`

調査開始時の既存変更はserviceとテストの2ファイル。調査中にprofiles、owned-execution、そのintegrationテスト、Lisp efficiencyテストにも変更が現れた。後者の無関係な変更は検査対象に含めず保全した。本レポート以外の変更は本調査では作成していない。ログ・設定・資格情報・DBの修正、commit、push、インストールは行っていない。

限定テスト成功時の関連ソースSHA-256（実行前後で一致）:

| ファイル | SHA-256 |
|---|---|
| `src/dsh/models/service.ts` | `c113768dba16e0e47d511e8d0248134dda32966bc5f67c9a020bd2dfcce3eb69` |
| `src/dsh/models/profiles.ts` | `0827cf7e459ccb27c05945dbbae3035caad4a0ae8587feab909b41f3f62d37b6` |
| `tests/dsh/unit/kiokuko-models-service.test.ts` | `b06cacba77f7f810fa10bf8d2f607220363110b9081a612f46c2084e56946d1d` |
| `src/dsh/models/vendor/opencode-adapter.ts` | `5195215dd5cc3578754acdc901621f203998b5ff54882d7f2c1c65e5414205fa` |
| `tests/dsh/unit/opencode-stream-lifecycle.test.ts` | `1833d9361ba3636b239086909b81298c27dbe278c3741ce58f6d783b0cefdf12` |

## 追補：修正と検証（2026-11-04）

上記は調査時点の記録である。以下は、その後の5項目の修正依頼に対する結果。既存・並行作業の差分は保持し、コミット・公開・稼働中プロファイルの更新は行っていない。DSH本体については、ユーザーの追加指示「今回は修正案までにする」に従った。

### 1. エラー詳細の欠落

`agenticreplay-hooks.ts`、`agenticreplay-recorder.ts`、`harness/factory.ts`を修正した。モデルのerror/aborted finish、stream例外、agent/error、harness-actionの各経路で、診断コード・HTTP status・provider request ID・再試行待ち時間・秘匿化した説明を保持する。modelCallId、session ID、turn、step、native sequenceで関連イベントを照合できる。例外は元の実行経路へそのまま返し、観測処理のために実行結果を置き換えない。

診断は明示的なフィールドに限定し、説明は最大2,000文字。metadataモードでは説明を記録しない。認証情報、スタック、任意のcause、HTTP body/headerを丸ごと保存しない。既に欠落した過去ログの詳細は復元できない。

### 2. 指定の更新コマンドと配布物

実際のpnpm 12.16.1と一時プロファイルで、`file:old.tgz`依存に対する`update kiokuko-dsh --latest`が成功終了しても、0.0.1のまま残ることを再現した。localhostの模擬レジストリが0.0.2を返す条件でも同じであった。提案する`add kiokuko-dsh@latest`への変換では0.0.2へ移行し、依存指定もレジストリ形式になる。

[DSH本体への修正案](patches/dsh-latest-local-update.patch)は、単一のインストール済みfile/link依存を明示的に`update/up/upgrade ... --latest`する場合だけレジストリ最新版へ変換する。通常のレジストリ依存、未インストール、Git固定、`--latest`なし、追加オプションのある形式は変更しない。対象の公式DSHリビジョン`8bd073392eef6f54e921a093b95076248eb08cbb`に対する`git apply --check`は通過した。**DSH本体への適用、DSH本体のテスト実行・配布は行っていない。修正案のpnpm引数の実行確認と、DSH全体での受け入れ確認は区別する。**

kiokuko-dshには`dist/build-info.json`の生成を追加した。起動ログ、toolExposure診断、AgenticReplayのrun.startに、ロード時点のpluginVersion・buildId・sourceCommit・Node版を記録する。buildIdは配布されるdistファイルの内容から生成する。sourceCommitはベースコミットであり、未コミット差分を含むビルドの完全な同一性はbuildIdで確認する。ソース実行や旧配布物で取得できない値はnullで示す。

現在のソースは未公開である。また、DSH修正案も未適用のため、**提示された4コマンドだけで今回の修正が導入される状態になったとは報告しない**。

### 3. 保存済みInfron/Nousの推論強度

既存の修正を保持し、保存済み設定の起動時復元、一覧表示、明示的な無効化・独自レベルの維持、high/offの実送信形式を確認した。モデル再取得は`save()`の共通補完を経由しており、Nousも補完される。Infronだけだった再取得の回帰テストをNousにも拡張した。実サービスへの認証付きリクエストは行わず、通信形式はlocalhostの模擬APIで検証した。

### 4. 完了基準IDと継続入力

完了基準は、現在のcoding workflow内の短いcriterionIdを正式な`coding:<workflowId>:<criterionId>`へ解決する。別workflowの名前空間付きIDは書き換えず拒否し、修正方法を構造化したエラーで返す。短いIDと正式IDで同じcallIdを再送しても、一つのbindingとして扱い、再承認しない。bindingだけで検証済みにする処理は追加していない。

継続入力では、同一native turn内の追加ユーザー入力を実際のDSHループで再現した。旧入力のキャッシュを使い続けると`dsh continued turn was reused with different bound input`が発生した。現在のtask leaseと出所に結び付いた判断を確認した後で旧キャッシュを失効させ、新しい入力のbindingを保持するよう修正した。公開プラグイン／アダプター両経路で同じrunを継続でき、別owner・別repository・古いrevision/generation・停止状態の拒否も維持される。

### 5. toolExposure等の診断

警告・投影ログにschema、時刻、diagnosticId、agent/session/run ID、論理turn・native turn・step・native sequence、prepare generation、intake/selection/policy状態、closed/failed、取得可能な直前の失敗診断、ロードされた版・ビルドIDを追加した。従来のツール数・説明量・削減できなかった理由は保持した。同じ理由が別sessionで起きた場合も記録され、重複抑制の保持数は512件に制限する。

Session ID検査にはscanId、時刻、所要時間、失敗一覧の省略件数、ロード版を付け、個別失敗を同じscanIdで照合できるようにした。providerプラグイン由来のDeepSeekモデル一覧取得ログはこのリポジトリの出力ではないため変更していない。toolExposureはコンソール診断であり、全コンソール出力をAgenticReplayへ自動転記する変更ではない。

### 検証範囲

検証には公式DSH `8bd073392eef6f54e921a093b95076248eb08cbb`／`0.2.2-alpha.3`、macOS arm64、Node 26.12.1を使用した。途中で開発依存とfixtureのDSH版が混在していたため、リポジトリ既定のstage処理で同一リビジョンに揃えた。混在時の`tools.restrict()`失敗と、修正対象の継続入力エラーを区別した。

| 検証 | 結果 | 証拠ログ |
|---|---|---|
| 記録、モデル設定、完了基準、継続入力、toolExposure、履歴、ハーネスの関連15ファイル | 334件成功、失敗0、skip 0 | `/tmp/kiokuko-five-final-tests.log` |
| 最終のエラー通知修正後、ハーネス・記録・native E2Eを再検証 | 29件成功、失敗0、skip 0（上記との重複あり） | `/tmp/kiokuko-five-harness-final.log` |
| `npm run typecheck` / `npm run build` | 成功 | `/tmp/kiokuko-five-delivery-typecheck.log`、`/tmp/kiokuko-five-delivery-build.log` |
| `node scripts/verify-agenticreplay-consumer.mjs --pnpm` | 空の利用環境へのインストール、7イベントの保存・読出し、診断とbuildIdの照合が成功 | `/tmp/kiokuko-five-delivery-consumer.log` |
| `node scripts/pack-check.mjs`（通常モード） | import、クライアント成果物、相対参照、同梱guardrailのnative smokeが成功 | `/tmp/kiokuko-five-delivery-standard-pack.log` |
| 同検査の公式DSH・Lisp有効モード | 成功。修正した判定入力テストを含む配布物のnative受け入れ検証も通過 | `/tmp/kiokuko-five-delivery-native-pack-green.log` |
| pnpmの更新再現と提案する引数の検証 | 現行updateは0.0.1のまま、提案addは0.0.2へ更新 | `/tmp/kiokuko-five-update-before.log`、`/tmp/kiokuko-five-update-proposed.log` |
| DSH修正案の`git apply --check` / `git diff --check` | 成功。DSH本体の対象ファイルは未変更 | 修正案：`docs/patches/dsh-latest-local-update.patch` |

334件の一括検証中は、対象ソース・スクリプト・テスト等1,154ファイルの実行前後のハッシュが一致した。その後のエラー通知の説明文を秘匿化する修正で型不整合を検出し、修正後に上記29件・型検査・ビルド・配布物の利用環境検証を実行した。失敗した中間版を最終成功の証拠にはしていない。

追加した配布物のnative検査では、Lisp提案テストの旧期待値「意図判定が合計1回」が失敗した。事前判定はqueued messageだけを持ち、実ターンではhostに結び付いたworkspaceが追加されるため、判定入力は異なる。テストを、2回の入力の差分がworkspaceだけであること、実ターンのworkspaceが実際の作業ディレクトリと一致すること、ユーザーへの確認は1回だけであることの検証に更新した。単独再検証（`/tmp/kiokuko-five-pack-isolated-green.log`）と配布物のnative検査の再実行は成功した。製品の判定や確認処理はこのテスト修正で変更していない。

最終の配布候補はversion `0.2.44`、buildId `e887c4ce64ac0c1e00a169985057311cc1f47a9f9e2a04c08e82d999654d3018`。これはローカルで作成・検証した配布候補の識別子であり、公開済みパッケージや現在動いているプロファイルの識別子ではない。

全リポジトリのfull検証・リモートCI・liveサービス・既存プロファイルの入れ替えは今回の確認に含めない。
