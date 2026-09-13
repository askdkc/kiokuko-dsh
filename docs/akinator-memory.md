# Akinator の記憶検索とプロフィール補助

通常のDSH入力では、現在の依頼とcwdから対象・成功条件が補われる。この動作を維持し、必須項目が揃っていれば過去プロフィールを検索しない。状態確認は`getAkinatorStateService()`、作業用記憶の配信は既存のscoped brokerが担当する。

互換APIのタグ検索は、`entry_revision_tags`と現行revisionを結合し、タグが一致した候補だけを展開する。不適格な候補が続いてもkeyset cursorで次ページを取得する。複数タグの重複を除き、従来と同じ順序で最大12件の適格な記憶を返す。全タグ一致候補が不適格な場合、検査件数自体は多くなり得る。

## 設定

DSHのKiokukoプラグイン設定に指定する。既定は`off`。

```yaml
akinatorMemory:
  mode: off
  maxCandidates: 64
  maxHintsPerField: 3
  maxElapsedMs: 50
```

| mode | 動作 |
|---|---|
| `off` | プロフィール検索なし。状態取得・タグ検索の改善と新規確定プロフィールの索引更新は有効 |
| `shadow` | 検索と採用案を記録する。プロフィール・質問・記憶配信は変更しない |
| `suggest` | 不足項目の質問に、前回の候補と出典を表示する |
| `resolve` | 条件を満たすtargetだけを補完し、それ以外は候補提示に留める |

候補IDは最大64件、各IDの正規プロフィール展開は1回、候補生成SQLは最大3回。完全性確認・binding検査・正規データの照合・保存SQLはこの3回に含まない。候補文字列は最大1024文字、フィールドごとに最大3件。設定の上限を超える値と未知フィールドは拒否する。

`maxElapsedMs`は段階間と候補展開間で検査する予算。同期SQLiteの実行中のSQLは中断できず、hard timeoutではない。時間・件数上限で検索を打ち切った場合や未投影の履歴がある場合は、自動採用しない。

まず`shadow`で確認し、`suggest`、必要な場合だけ`resolve`へ進める。設定反映にはプラグインの再読み込みが必要。既存requestの採用結果は再評価しない。`off`への切替は新規採用・候補表示を止め、保存済みプロフィールや監査記録を書き換えない。

## 採用条件と限界

現在の明示入力・cwdに基づく補完・ユーザー回答を優先する。過去のtaskType、expected、constraintsを自動採用しない。constraintsの不足だけで検索しない。chatは対象外。

自動採用するtargetには、次の条件をすべて要求する。

- 現在のtargetがnullである。
- 現在の依頼に、そのパスが独立したトークンとして記載されている。
- 現在のrepository内に実在し、symlink・親ディレクトリ参照・未知の外部パスではない。
- 履歴のrepository/workspace、確定プロフィール、hash、出典、runのcompleted状態を正規データで確認できる。
- 元のtargetは`client_supplied`または、回答レコードと一致する`user_answer`である。
- 検索範囲内に異なるtargetの競合がなく、索引の欠落・検索打切りがない。

初期版はパスの表記を推測で同一視しない。サブディレクトリをcwdにした依頼では、相対パスを自動採用しない。長い文章として表現された対象、移動済みパス、短い日本語などは候補提示または従来の質問に戻る。FTSの一致や順位スコアを正しさの確率として扱わない。

ファイル存在確認は書き込みトランザクション前の観測であり、後続のファイル操作を許可する証明ではない。実際の操作では既存の権限・所有者・lease・検証境界を引き続き適用する。memory-reasoningが利用できない場合や必須capabilityが不足する場合、履歴の採用・表示を行わない。

候補を選ぶ場合も自由入力する場合も、既存の回答処理を通る。実際に回答した値だけが`user_answer`になる。自動補完は`memory`として保存し、架空の`akinator_answers`は作らない。knowledge-pathのgrounded条件に`memory`を追加していない。

## 保存・再試行・削除

正規データは`akinator_sessions`、`akinator_answers`、`run_intakes`、`ledger_runs`。migration 016のプロフィール文書・信号・word FTS・trigram FTSは再構築可能な投影。

新規確定intakeと、回答によって確定したintakeを同じトランザクションで投影する。runの成功状態は検索時に正規レコードから読む。単にreadyになった履歴を作業成功とみなさない。元のプロフィール・出典・repository bindingの変更は索引を無効化する。古い文書のhashや本文が正規データと違う場合は整合性エラーとする。

元の公開requestをhashした後、冪等性処理の新規実行側でのみ検索・採用する。run、intake、採用結果、出典参照、ledgerは原子的に保存する。off以外では設定、検索状態、元と結果のprofile hashを初期resolutionに保存する。replayでは新たな候補を採用せず、回答済みフィールドも初期状態に戻さない。

候補表示時は元のプロフィール・出典・completed状態を再検査する。sourceのrun-intakeを削除すると、その投影・FTS・信号を削除し、sourceを参照する候補本文を含んだresolutionも削除する。既存の正規プロフィールを削除する方針自体は変更していない。

## 既存履歴の投影・再構築

migrationは過去履歴を全件解析しない。未投影の適格履歴が残る間は`coverage: partial`となり、自動採用しない。通常入力時にbackfillはしない。

検証用DBまたは正規のバックアップ手順で用意したDBで先に確認する。稼働中SQLiteの本体ファイルだけをコピーする手順は使わない。

```bash
npm run build
npm run memory:backfill:akinator -- --database /absolute/path/to/test.sqlite3

# 元データ変更後の再構築。正規データは変更しない。
npm run memory:backfill:akinator -- --database /absolute/path/to/test.sqlite3 --rebuild --batch-size 100
```

明示的な既存の絶対DBパスが必須。既定DBを推測しない。事前に通常のmigrationを適用しておく。batch単位で投影とcursorをcommitするため、中断後は同じコマンドで再開できる。完了済みcursorより前のレコードを再投影する場合は`--rebuild`を使う。パッケージにはbackfillスクリプトと必要なdistモジュールを同梱する。

## 検証と測定

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:evaluation:akinator
npm run test:benchmark:akinator
# 明示実行: 通常entry 10万件、profile 1万件
npm run test:benchmark:akinator -- --large
npm run test:sampledb
npm run test:e2e:dsh
npm run build
npm run publint -- --pack npm
npm run pack:check
```

評価結果は`artifacts/akinator-memory-evaluation.json`、性能測定は`artifacts/akinator-memory-benchmark.json`と`artifacts/akinator-memory-benchmark-large.json`。合成データだけを使い、履歴本文・個人の絶対パスを出力しない。

測定対象は検索SQL回数、entry/profile展開数、候補数、経過時間、CPU、RSS、同期処理によるevent-loop遅延。通常prepare全体と、その中のwrite transaction保持時間も別に測る（現在入力が揃ったケース、discovery off、embedding runtimeなし）。SQLiteはメモリ内DBであり、初回クエリーとwarmサンプルを測る。ディスクのcold cacheや実運用の待ち時間の測定ではない。

品質評価では明示対象、chat、作業種別の違い、競合、索引欠落、打切り、memoryの循環、別repositoryを扱う。有限の合成ケースの誤採用0件を、実運用の誤り確率0とは解釈しない。ユーザーの候補訂正率・自動採用後訂正率は未測定でnull。単純な不足項目数と、実際の質問回数を区別する。

### ローカル検証結果（2026-09-13）

Node v26.5.0 / SQLite 3.53.4、macOS arm64、通常entry 10,000件・過去profile 1,000件の合成データで測定した。

| 測定 | 旧方式 | 今回 |
|---|---:|---:|
| タグ検索の本文展開 | 10,000件 | 12件 |
| タグ検索のSQL発行 | 60,001回 | 73回 |
| タグ検索の観測p95 | 約1,282ms（3標本） | 約2.25ms（10標本） |
| 状態取得の記憶本文展開 | — | 0件（状態SQL 1回） |
| resolve probeの正規profile展開 | — | 1件、SQL 11回、観測p95約1.87ms |

これは局所的な検索の比較。通常prepare全体は各modeで約7.0〜7.1秒、entry展開30,300回が残った。既存のscoped brokerや整合性検査が含まれるため、プロフィール検索の改善率をprepare全体の改善率として扱わない。短い標本列であり、p95は実運用の応答保証ではない。

合成データ13ケースで誤採用0件、候補を期待するケースのRecall@64は1.0。既存検索評価・性能評価・token efficiency評価とsample DBの移行検証も通過した。native prepare→候補→回答はfixtureで確認し、回答後の由来、replay、rollback、purge、FTS更新・再構築、v15からの移行、knowledge-pathの非昇格を回帰テストで確認した。

10万件のentryと1万件のprofileでも、タグ検索の本文展開は100,000件→12件、SQL発行は600,001回→73回だった。観測p95は旧方式約12,566ms（2標本）、索引方式約1.85ms（5標本）。resolve probeは正規profile 1件、SQL 11回、観測p95約10.51ms（5標本）。標本数が少ないため、速度倍率や運用上の応答保証には使わない。

同じ10万件のentryと1万件のprofileでは、通常prepareが既存の`CONTEXT_SELECTION_STATE_MAX_ENTRIES = 10_000`に達して`INTEGRITY_ERROR`を返すことを確認した。この上限は変更していない。ベンチマークはこの拒否を`prepareMeasurements[].status: blocked`として記録し、検索単体の結果と区別する。

単体191件、統合378件成功（既存の実機インストール試験1件skip）。追加のDSH gate試験では、標準Skill catalogを使い、候補の提示から実際の回答保存まで確認した。backfill CLIは検証用DBで再構築・再実行・明示DB必須を確認した。

配布物検査は成功。`publint`の既定packはこの環境のCorepackで失敗したため、書込み可能な一時npm cacheと`--pack npm`で検証した。実機DSHのE2Eは、固定版DSH CLI/runtimeがないため必要ケースがskipとなり、専用runnerは失敗を返した。DSHでのインストール・再読み込み後の画面操作と実モデルを含む動作は未検証。

コードの確認は、永続化・検索に`code.effects.v1`、再試行に`code.protocol.v1`、出典・設定境界に`code.boundary.v1`、純粋判定に`code.domain.v1`、質問UIに`ui.forms.v1`を適用した。現在の入力から、設定・scopeの受渡し、原子的な保存、候補の再検証、ネイティブ質問・回答、配布物までを確認対象とする。

## 切り戻し

まず`akinatorMemory.mode: off`に設定し、プラグインを再読み込みする。新しいsource値を読み取れるコードは維持する。

設定offは、旧バイナリへの安全なdowngradeを意味しない。旧migrationのchecksumを変更したり、`memory`を`client_supplied`に偽装したりしない。旧バイナリへ戻す必要がある場合は、移行前の正規バックアップから復元する明示的な運用が必要。

Go/Workerは追加していない。今回のローカル計測だけでは、別プロセス化の配布・運用コストを正当化できない。実際の同時入力で応答性の問題が残る場合に、まずWorker Threadによる隔離を別途比較する。
