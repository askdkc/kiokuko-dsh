# 記憶の根拠・説明・忘却

full plugin と modular core は同じ読み取り・忘却サービスを使用します。説明と忘却はモデルを呼び出しません。既存のレビュー間隔、日次予算、プロバイダー選択は変わりません。

## 操作

```text
/kioku-memory explain ENTRY_ID
/kioku-memory explain ENTRY_ID --revision 1 --json
/kioku-memory forget ENTRY_ID --revision 2
```

workspace と native session はホストが決定します。モデル向けの `memory_explain({entryId, revision?})` は読み取り専用で、Memory Review の適用判定前にも使用できます。別 workspace の記憶にはアクセスできません。現在の依頼で配信された Global 記憶は、その配信に結び付いた権限で説明できます。モデル向け忘却ツールはありません。

説明には本文、適用条件、trust、現在の利用可否と理由、主張ごとの引用、native session、generation、sequence、source hash、訂正・継承先の revision と claim ID、履歴、登録済み派生 manifest を含めます。現在の依頼で取得した記憶には取得理由と順位も付けます。順位は正しさの確率ではありません。通常の検索結果には根拠の有無と claim ID だけを加え、引用は説明時に読みます。

## 根拠と互換性

新規予約は Review v2 / Finalizer v4 を使用します。保存済みの予約は旧形式と採用規則を維持します。新形式の本文は、採用した主張の text を二つの改行で連結したものです。主張ごとに短い完全一致の引用を要求し、提供した evidence ID、出典 hash、利用可否を照合します。改変された引用、欠落した出典、秘密情報、文脈専用の出典は操作を保留します。

引用一致が示すのは出典との対応です。内容の正しさ、因果関係、恒常的な好みを証明しません。既存の trust と verification 条件を維持します。「今回だけ」「未実施」「失敗した」などの条件を主張本文に保持する必要があります。

根拠 manifest は entry/revision に結び付け、本文と同じ transaction で保存します。訂正は追記型 revision で、明示的な `supersedes:{revision,claimId}` を使用します。変更しない主張は `inherits:{revision,claimId}` と元の正確な本文を指定して根拠を継承できます。曖昧な前世代や異なる適用条件は保留します。旧記憶は「詳細な根拠なし」と表示し、会話履歴から推測で補完しません。

031 に続く 032/033 migration は根拠、永続 tombstone、忘却 receipt、ジョブ形式、配信・説明 receipt の失効情報を追加します。既存 migration や既存本文は移行時に変更しません。

## 忘却の範囲

`--revision N` は現在の revision に対する競合検査です。忘却対象は entry の全 revision と、既知の依存関係を持つ派生記憶全体です。複数の出典から作った派生物も、対象に依存すれば全体を除去します。

transaction 内で本文・引用・検索データ・embedding・派生 manifest を除去し、関連する保存済みジョブの入力・出力・候補 snapshot を専用処理で除去します。通常の更新で immutable なジョブを書き換えることはできません。実行中処理の lease/claim を失効させ、遅延応答も保存できなくします。以前の配信、適用判定、検証結果は失効します。ID、hash、件数、費用集計は残ります。

本文を持たない永続 tombstone により、同じ native session の同じ出典 hash、登録済み派生元、明示的な旧 provenance の再処理を拒否します。処理 generation の変更や再起動で解除されません。同じ操作の再送は保存した receipt を返します。revision が変わっている場合は何も変更せず競合を返します。意味が似ているという理由だけで、新しい独立した発言を禁止しません。

保証対象は Kiokuko が管理する記憶、既知の派生物、同じ出典の再処理です。native 会話ログ、外部へ送信済みの情報、バックアップの消去は対象外です。native ログは保持し、忘却した記憶の説明結果と Kiokuko の記憶注入を次回の有効なモデル入力から除去します。

## 検証

```sh
npm run typecheck
npm run test:memory-review
npm run test:index-reasoning
npm run test:evolution
node scripts/run-tests.mjs tests/dsh/integration/memory-evidence.test.ts
KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" KIOKUKO_REQUIRE_DSH_NATIVE=1 node scripts/run-tests.mjs tests/dsh/integration/memory-evidence-native.test.ts tests/dsh/integration/memory-review/native.test.ts
npm test
npm run build
npm run publint
npm run pack:check
npm run test:modules
```

native ケースは DSH fixture が必要です。必須ケースを skip した結果は合格扱いにしません。これらは保存・説明・忘却の動作検証です。回答品質の改善率には別の実モデル評価が必要です。
