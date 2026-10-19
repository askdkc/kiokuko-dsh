# 判断診断

`/kioku-decisions diagnostics` は、現在の native session の判断経路を SQLite の既存記録と関連付けて表示します。
`/kioku-decisions diagnostics <decision_id>` で一つの試行に絞れます。表示は読み取り専用のスナップショットで、モデル通信、再実行、migration、評価ラベルの追加を行いません。

## 記録する経路

- `DecisionService` の受理済み batch の評価結果・fallback・cache hit。`DecisionObservation` と DB は同じ不変の `decisionId`、`requestRef`、`inputDigest` を使います。実際の provider 呼び出しは `providerDispatched` で区別します。
- 実 decoder が出した Choice 診断の確信度、上位確率、差、受理閾値、失敗した条件。cache hit で推論を行ったようには記録しません。
- 公開 adapter と Core の OnDemandIntake による現在の依頼参照、解釈、経路、確認質問、受理した UI 回答、native followup の再捕捉。モデルが提出する `requestIntent` schema に診断 ID の指定欄はありません。
- host が実際に run を束縛した admission。元の解釈が参照する task と新しい実行 run が異なる場合も、元の参照は書き換えません。
- 明示的な task resume／native session の所有権引き継ぎ。対象 session、task revision／generation、source epoch をその時点の DB から取得します。
- Enno operation receipt の既存 trigger が作った turn receipt／continuation outbox、未提出ターンと予測可能な失敗の既存取引。

有効な型付き判定で必須項目が解決した実行候補は、原文と候補を独立した provider 呼び出しで照合し、同梱 Rust の有限領域制約で検査します。`semantic_match`／`detector` には実際の入力・出力 digest、実行ファイル hash、版、完全性、所要時間と結果を記録します。通常の request-intent 分類だけをこれらの成功として扱いません。説明・情報収集・未解決の必須項目では未実行、明示的な判定 OFF は `assessment_disabled`／`not_run`、有効な検査の障害は unavailable として区別します。制約・対象・revision と利用不能の扱いは [micro judge の契約](micro-judge.md) を参照してください。

## 同一性と因果関係

migration 044 は `dsh_diagnostic_attempts`、`dsh_diagnostic_events`、`dsh_diagnostic_gaps`、`dsh_diagnostic_reviews` を追加します。既存の判断結果、task、Goal、native 会話は移し替えません。

試行 ID は host が発行し不変です。イベントは試行内の連番を DB の writer transaction で割り当てます。同じ event ID と正規化後の同じ内容だけを再送として受理し、異なる内容や別の試行への使い回しを拒否します。質問→回答→再開には同じ試行内の正しい親イベントが必要です。既に受理した質問への別回答は別の内容で上書きできません。受理した native 回答から新しい入力を再捕捉すると、resume の `nextDecisionId` が新しい試行へ接続します。同一 session の後続 turn で、その回答の message ID digest を入力参照に含む試行だけを結べます。これにより確認前の判定と、最新回答からの再判定を同じ lineage で追跡します。

入力・context digest、task revision／generation、source epoch、取得できる workflow／Goal／scope revision を束縛します。新しいイベントの古い束縛は記録できません。再開の新しい束縛は既存 task の実際の状態から取得します。再起動後も質問・回答 ID の digest から関連を復元します。別 session の同名回答を同一回答として再利用しません。既に記録されたイベントの正確な再送は履歴の再利用であり、現在の実行権限にはなりません。

provider の試行 ID は extraction イベントの `evaluationDecisionId` に関連付けます。加えて、同じ依頼に属する独立した評価を `providerAttempts` に表示します。同じ依頼に属することだけで、その評価を別の試行の結果や実行権限とは扱いません。

## 秘密・本文を複製しない

診断表には、依頼原文、質問本文、回答本文、ツール結果本文、認証情報、provider の生エラーを保存しません。原文・参照・モデル・provider 版・方針は digest または既存の ID への参照で関連付けます。Choice の質問・選択肢も digest で表します。モデル名などの実際の設定・結果を確認する場合は、`resultRef` の指す既存 `dsh_decision_results(request_id,input_digest)` と `dsh_decision_bindings` を参照します。

reason は有限の code だけを許可します。session、task、receipt、outbox の参照は host が確認した既存 ID から取得し、モデル自由文を理由や新しい ID に変換しません。表示にも原文や outbox message 本文を出しません。

## 診断の障害と取引

診断を許可・停止・完了判定の入力として使用しません。診断の追記は保存点で隔離し、記録エラーが既存処理を中止したり、実行権限や偽の完了を作ったりしないようにします。

Enno の完了 receipt、未提出・失敗の receipt/outbox、task resume／引き継ぎへの追記は、同じ DB の既存の取引内で行います。外側の rollback は診断も取り消します。判断 cache 保存や native UI／followup との記録は別の観測点です。native 会話ログと SQLite、または別 DB 間の atomicity は主張しません。

保存点の失敗は、可能なら `dsh_diagnostic_gaps` に内容を含まない code を記録します。DB 全体が利用不能な場合はプロセス内の loss count と表示の `DIAGNOSTIC_UNAVAILABLE` で区別します。診断表示は次を分けます。

- `persistedGaps`: DB 全体に保存された欠損件数。特定 session だけの件数ではありません。
- `volatileLosses`／`runtimeLosses`: プロセス内で観測した書き込み／DB 利用の失敗。再起動で消えます。
- `missingReceiptLinks`／`missingContinuationLinks`: 表示対象の試行について、確定済みの既存行に対応する診断イベントがない件数。記録前の host crash も、元の receipt/outbox が残っていれば検出できます。
- `authoritativeLinks`: 既存 receipt/outbox の現在の ID、対象 session、状態。診断イベントの存在だけから配信成功とは推定しません。

診断表示は直近100試行、同じ依頼の provider 評価は各20試行までです。履歴全件の集計値と表示対象の欠損数は異なる範囲です。上限到達は `truncated` で示します。

## 評価と保持

停止事例は実際に確認質問を記録した試行です。`reviewDiagnosticStop` は独立した人間レビュー／テスト oracle の参照 digest による評価用 API で、モデル tool や診断表示からは呼べません。再開できたことや最後まで処理できたことから正解を自動ラベル付けしません。

`falseStopRate = falseStops / evaluated`。未評価なら `null` です。`evaluationRate = evaluated / stopped` は別に表示し、停止事例そのものがなければ `null` です。ラベルの黙った変更・上書きは認めません。

既存の判断結果は永続保存され、自動 TTL 削除の仕様はありません（`docs/model-selection.ja.md` の共有判定 cache 参照）。今回も独自の削除期限・本番 prune は追加していません。診断行は関連 run または試行の削除に従って cascade しますが、既存テーブルの削除制約は維持します。保留中の質問を経過時間や再起動だけで消しません。cascade、保留状態、再起動をテスト DB で検証し、本番 DB の直接 migration や削除は行いません。

## 検証入口

    node scripts/run-tests.mjs tests/dsh/integration/decision-diagnostics.test.ts tests/dsh/integration/decision-diagnostics-native.test.ts tests/dsh/integration/request-intent-clarification-native.test.ts tests/dsh/integration/request-intent-clarification-adapter-native.test.ts tests/dsh/integration/turn-process.test.ts

native 試験は実際の DSH model loop／質問サービス／ファイル読み取り経路を使い、モデルと provider・UI 回答は scripted fixture です。実モデルの意味判断品質やインストール済みプラグインの更新を証明するものではありません。
