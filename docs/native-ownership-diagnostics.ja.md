# ネイティブジョブの管理権限診断：PLANと実装

## PLAN

基準ソース: `c84acbb9eedc85891a7fa49e741bc5bc9e883a1f`。

1. `hasUnclassifiedNativeJobs()` の条件、評価順序、最初の不明ジョブでの短絡評価を維持し、理由コードを取り出す。
2. 任意の通知コールバックを追加し、adapter/core両ホストで共通の診断出力へ接続する。
3. 環境変数で明示的に有効化した場合だけ固定コードを出力する。診断出力の例外は管理権限判定へ伝播させない。
4. 理由コード、判定の互換性、既定時の無出力、機密情報の非出力を検証する。

## 利用方法

DSHを起動するプロセスに次の環境変数を設定する。

```sh
export KIOKUKO_NATIVE_OWNERSHIP_DEBUG=1
```

以降、通常の起動コマンドで、変更を含むKiokuko DSHを読み込む。
解除は `unset KIOKUKO_NATIVE_OWNERSHIP_DEBUG` 後に再起動する。
設定がない場合や値が `1` 以外の場合は出力しない。
出力先はホストプロセスの `console.info`。表示・保存先はホスト側のログ設定に従う。

```text
[kiokuko-dsh] {"schema":"kiokuko.native-ownership.v1","reason":"registration_missing"}
```

| コード | 意味 |
| --- | --- |
| `job_status_unknown` | 終了済みでもrunning/stoppingでもない |
| `job_kind_not_bash` | ジョブの種類がbashではない |
| `job_owner_mismatch` | ジョブの所有者が現在のセッションと異なる |
| `registration_missing` | 該当する登録イベントがない |
| `registration_ambiguous` | 該当する登録イベントが複数ある |
| `registration_owner_mismatch` | 登録イベントの所有者が現在のセッションと異なる |
| `registration_kind_not_bash` | 登録イベントの種類がbashではない |
| `registration_started_at_mismatch` | 開始時刻が登録イベントと異なる |
| `tool_call_id_invalid` | callIdが文字列ではない |
| `root_call_id_invalid` | rootCallIdが文字列ではない |

1回の判定で最初の不明ジョブの最初の理由だけを出力する。正常・終了済みジョブは出力しない。
診断を有効にしている間は判定のたびに出力するため、調査後は解除する。
コマンド、認証情報、ジョブやセッションのID、実際の開始時刻、例外本文は含めない。
空文字列のcallId/rootCallIdを許容する既存条件も維持する。
このログはネイティブジョブ分類のみが対象であり、DB上の管理対象操作や子セッション等による制限理由は対象外。

## 検証結果

- 変更前の既存単体テスト: 2件成功。
- 変更後の単体テスト: 4件成功。10種類の理由、終了状態、評価順序、診断例外、出力の限定を検証。
- 変更前関数を一時ファイルに抽出し、登録欠落時の通知を要求する検証が失敗することを確認。
- `node_modules/.bin/tsc -p tsconfig.build.json --noEmit`: 成功。
- `node scripts/run-tests.mjs tests/dsh/unit/native-execution-ownership.test.ts tests/dsh/integration/background-native-ownership.test.ts`: 10件中6件成功、4件失敗。
- 統合テストのadapter native/PTCは成功。adapter Lisp、core native/PTC/LispはLispManager初期化の `spawnSync /bin/ps EPERM` により本体の動作検証に到達できず、未検証。
- 稼働中DSHへの反映、配布ビルド作成、実セッションでの診断出力確認は行っていない。
