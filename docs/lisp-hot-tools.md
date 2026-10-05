# プロジェクトで共有する Lisp 関数

コーディング依頼時の既存の確認で「Lispモードを使う（通常実行）」を選ぶと使える名前付き関数です。同じプロジェクトの
別セッション・別エージェントから、検証済みの稼働版を呼び出せます。
共有するのはコードと承認済み条件で、入力や結果の参照権限は共有しません。

## 試作版からの実装方針

ZIP の試作をそのまま別の実行環境にするのではなく、既存の作業用ツール、
保護付き SBCL、操作履歴、利用者への確認画面に統合します。

1. 型と有限個の入力・期待値を不変の検証条件として保存し、利用者が承認する。
2. 候補と依存関数のコードを固定し、コンパイルと全条件を保護付きワーカーで実行する。
3. 承認条件・稼働版・セッション世代を再確認し、稼働版の切り替えと成功記録を
   一つのトランザクションで確定する。
4. 呼び出し開始時に版を固定する。並行更新は開始済みの呼び出しを変更しない。
5. 再起動、取消、失敗、保存上限、参照期限を既存の履歴・復旧経路で扱う。

試作の文字列接頭辞による内部 ID は使いません。利用者の操作 ID は既存の
ホスト発行 ID に対応付け、内部の成果物には独立した UUID を使います。

## 使用例

設定の `lisp.enabled: true` と SBCL が必要です。既存の選択画面で Lisp を選べば、
共有関数をそのまま利用できます。選択肢の順序、番号キー・修飾キー・Enterによる操作、
Lispを使わない場合の通常実行／役小角の選択は変わりません。選択は従来どおりセッションに保持します。
従来の常駐Lispも維持し、共有関数は別の保護付きワーカーで実行します。
ワーカー枠がすべて使用中の場合は `WORKER_LIMIT` で停止します。

次は任意の確認コマンドです。有効化の追加操作は不要です。

```text
/kioku-lisp hot
```

常駐ワーカーを使わない作業用モードは、従来どおり `/kioku-lisp enable-task` で明示的に選べます。

モデルは以下を提案できますが、承認は確認画面から利用者が行います。

```json
{
  "operationId": "approve-add-one",
  "name": "add-one",
  "description": "整数に1を加える",
  "inputSchema": { "type": "integer" },
  "outputSchema": { "type": "integer" },
  "properties": [{ "input": 0, "expected": 1 }, { "input": -1, "expected": 0 }],
  "expectedContractRef": null
}
```

これを `lisp_hot_contract` に渡し、承認後の `contractRef` を使います。
承認は「この条件を満たす候補への以後の更新を許可する」操作です。
有限の例を通過することは、全入力での正しさの証明ではありません。

`lisp_hot_install`:

```json
{
  "operationId": "install-add-one-v1",
  "name": "add-one",
  "contractRef": "承認結果のUUID",
  "expectedRevision": 0,
  "source": "(lambda (input) (+ input 1))"
}
```

初回成功は `revision: 1` と `bundleRef` を返します。
更新時は `lisp_hot_status` の最新の `revision` を指定します。
`dependencies: [{"binding":"helper","toolRef":"UUID"}]` で、呼び出し元が所有する
`lisp_define` の関数を組み込めます。保存時に依存コード全体を固定するため、
元の `toolRef` が期限切れになっても稼働版は使えます。

`lisp_hot_call`:

```json
{ "operationId": "call-add-one-41", "name": "add-one", "input": 41 }
```

結果は `value: 42`、`resultRef`、使用した `bundleRef` と `revision` を含みます。
同じ主体の `inputRef` を `input` の代わりに渡せます。`fields` は既存の
`lisp_call` と同じ JSON ポインター指定です。

| 操作 | 用途 |
| --- | --- |
| `lisp_hot_status {name?,offset?,contractOffset?}` | 10件ずつ稼働版を参照。名前指定時は条件本文を返し、`contractOffset` で2000文字ずつ取得 |
| `lisp_hot_contract` | 条件の新規承認・変更。変更には現在の `expectedContractRef` が必要 |
| `lisp_hot_install` | 現在の承認条件で候補を検証し、`expectedRevision` が一致した場合だけ公開 |
| `lisp_hot_call` | 呼び出し時の版を固定して実行 |
| `lisp_hot_deactivate` | `{operationId,name,expectedRevision}` を利用者が承認して無効化 |

## 境界と失敗時の動作

- 共有単位はホストが解決した正規のプロジェクトルートです。同じリモートの
  別クローンは共有しません。Git 管理外では解決された作業ディレクトリが単位です。
- 条件を変更しても旧稼働版は維持します。新条件による候補が成功した時だけ切り替わります。
  以後、旧 `contractRef` では新しい版を公開できません。
  無効化の確認は表示した稼働版に対するものです。条件だけが更新され、稼働版が
  変わっていない場合は、その確認で同じ版を無効化できます。
- `HOT_PROPERTY_FAILED` は候補の不合格です。旧版は維持されます。
  `HOT_REVISION_CONFLICT` / `HOT_CONTRACT_CONFLICT` は並行変更です。
  最新状態を確認し、変更内容を再検討してから新しい操作 ID を使ってください。
- 取消・無効化・セッションの終了・世代変更後の公開を拒否します。確認拒否、
  自由入力、確認 UI の不在や時間切れは承認になりません。
- 稼働中のコードとその依存コード、現在の条件は期限切れにしません。
  使われなくなった版・条件は、30日経過後のホスト起動時に整理します。
  未確定の操作が参照する版・条件は保持します。保存結果は従来どおり30日です。
- カタログ上限はプロジェクトごとに条件・版の合計10,000件 / 1 GiB、全体4 GiB。
  超過時は稼働版を削除せず、新しい登録を拒否します。操作履歴にも既存の上限があります。
- 条件は1〜32件、JSON全体64 KiB、依存関数を含むコードは256 KiBまでです。
  各検証は独立したワーカーで行うため、条件が多いほど更新時間が増えます。
- 入力・結果はセッションとエージェントに束縛されます。共有関数の呼び出しは
  他人の `resultRef` の参照権限や、作業ファイルの書き込み権限を与えません。
- グローバル変数やヒープの移行はありません。コードは呼び出しごとに新しい
  保護付きワーカーで実行し、ホスト RPC は許可しません。

再送は同一の操作 ID と同一の引数で行います。保存結果を返し、再実行しません。
`UNKNOWN` は成功でも安全な再試行でもありません。
`/kioku-lisp diagnostics 操作ID`、`recover`、必要なら `abandon 操作ID` で確認します。
`/kioku-lisp cancel` は検証中と確認待ちの処理も停止します。

## 検証方法

```sh
npm run typecheck
node scripts/run-tests.mjs tests/dsh/unit/lisp/hot-contracts.test.ts tests/dsh/unit/lisp/hot-store.test.ts tests/dsh/unit/lisp/hot-runtime.test.ts
KIOKUKO_REQUIRE_LISP_RUNTIME=1 KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime/node_modules" npm run test:lisp
npm test
npm run build && npm run pack:check && npm run publint
npm run test:modules
npm run test:skill-delivery
```

通常の `npm test` は保護付き SBCL / ネイティブ DSH の任意テストを省略します。
上記の必須実行を別途確認してください。ローカルテストの成功は、稼働中の
DSH プロファイルの更新、別プラットフォームの実行、リモート CI の成功を意味しません。
