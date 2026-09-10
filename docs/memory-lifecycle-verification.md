# 記憶の供給と連続動作の検証

新規の記憶供給は `context-ranking-v7` / projection version 1 を使う。通常の記憶は本文全体を保持し、派生記憶は適用条件・手順・検証・適用外条件・未解決事項を一体として供給する。予算に入らない場合は省略理由を残す。v6のdeliveryは旧形式で読み取る。

新規の終了処理にはevidence selection version 2を保存する。tool callと結果を関連付け、完全な組が予算に入らない場合は成功根拠にしない。migration 014より前のjobはversion 1のまま再開する。`prefix_reuse`が既定で、`bounded_evidence`は明示設定で使う。

検索状態の読み取り共有は、一つの同期的なSQLite snapshotの中に限定する。ordinary gateとretrievalの候補条件は別々に評価する。外部処理後・保存直前・モデルへの供給直前は現在性を再確認する。監査ログを保存したまま、失効した検索記憶をDSHの現行contextから取り除く。

## 再現手順

Node.jsと固定版DSHを用意し、その実体を指定する。以下のパスは実際のインストール先へ置き換える。

```sh
export DSH_BIN=/absolute/path/to/node_modules/.bin/dsh
export KIOKUKO_DSH_PACKAGE_ROOT=/absolute/path/to/node_modules
export KIOKUKO_REQUIRE_DSH_NATIVE=1
export KIOKUKO_REQUIRE_DSH_CLI=1
export KIOKUKO_EXPECTED_DSH_VERSION=0.1.5-rc.1
export KIOKUKO_REPEATED_REPORT_DIR=/tmp/kiokuko-lifecycle-results
export KIOKUKO_DSH_EVIDENCE_PATH=/tmp/kiokuko-package-lifecycle.json

npm run typecheck
npm test
npm run test:evaluation
npm run test:efficiency
npm run test:evolution
npm run test:evaluation:evolution
npm run build
npm run publint
npm run pack:check
npm run test:e2e:dsh
git diff --check
```

`test:e2e:dsh`は既存native試験、35の連続動作系列、パッケージの導入・Web起動・再起動・削除を検証する。パッケージ取得にはnpm registryへの接続か、完全な依存キャッシュが必要になる。

各系列は同じディスクDBを維持する。正常系列では内容の異なる3つのfixtureを実ツールで検証し、3回目で生成したlessonが4回目のnativeモデル要求へ届くことを確認する。訂正・重複通知・保存失敗・送信後中断・source/mode/lease変更も試す。Deepは専用の報告・記憶確定契約を検証し、episode生成を要求しない。

系列名は `scripts/repeated-memory-scenarios.mjs` に固定している。個別の再現では、対象を第1回から実行する。

```sh
KIOKUKO_REPEATED_SCENARIO=normal/prefix_reuse/save-failure \
node scripts/run-tests.mjs tests/dsh/e2e/repeated-memory-lifecycle.test.ts

node --import tsx scripts/run-selection-state-benchmark.mjs \
  /tmp/kiokuko-selection-state.json
```

1工程60秒、1系列300秒を期限にする。完了はログflush・worker終了・永続状態から判定する。未登録の系列、未実行、skip、期限超過は合格にならない。reportには設定・fixture digest・各回の状態・呼出回数を記録し、モデル要求本文を含めない。

## 評価の境界

scripted providerのnative試験が示すのは、制御・保存・記憶伝達が指定条件で成立したこと。一般的な無故障保証や、実モデルの回答品質の保証ではない。

状態収集benchmarkは20件と1,000件で旧読み取り方式と共有方式を交互に測定する。状態収集のp95改善率を、タスク全体の短縮率と呼ばない。fixture bytes、scripted usage、検索ヒット率を実token削減・実費用・タスク成功の代用にしない。

実モデルとembeddingの固定設定がない場合、`test:evaluation:evolution`は通信を行わず `unmeasured` を返す。有用性の採否には、同じ開始条件でのpaired比較によるタスク成功・誤適用・主処理と補助処理を合算したtoken・費用の別測定が必要になる。
