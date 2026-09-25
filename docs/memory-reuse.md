# 意味判定による記憶の再利用

既存検索の候補を TypeSafe または Bespoke Nimble で判定し、今回の依頼に使える記憶を優先します。埋め込みが未設定でも文字列検索の候補を利用します。検索候補に入らない記憶は発見しません。

フルプラグインと modular core の両方で設定できます。接続先と認証は `typedDecisions` を引き継ぎます。

```yaml
memoryReuse:
  mode: auto          # auto | off
  maxCandidates: 24  # 1..100
  budgetMs: 5000     # 疎通確認を含む一回の選別全体の上限
typedDecisions:
  mode: auto
  provider: typesafe
  typesafe:
    model: jev-latest
    timeoutMs: 5000
```

記憶判定の既定は Choice です。Noul を明示選択する場合は閾値を指定します。次の値は動作確認用の設定例であり、採用済み閾値ではありません。

```yaml
typedDecisions:
  provider: typesafe
  memorySelection:
    mode: noul
    policyVersion: memory-reuse-noul-v1
    acceptProbability: 0.9
    rejectProbability: 0.1
```

Noul は候補ごとに依頼への有用性、明示的な制約との整合、記憶に書かれた前提の充足を判定します。1問でも reject 閾値以下なら除外、3問すべてが accept 閾値以上なら優先し、他は保持します。前提不明は推測で肯定しません。Nimble／Laya に Noul を明示した場合は推論前に拒否され、既存検索へ戻ります。方式と閾値は新しい論理依頼に固定されます。

運用で Choice に戻す場合は `typedDecisions.memorySelection.mode: choice` を設定します。変更は新規リクエストから適用され、進行中の binding は書き換えません。

`auto` は利用確認済みの場合だけ有効になります。キーを設定しただけでは有効になりません。DSH の環境変数または既存の credential サービスでキーを解決します。コマンド入力中のキーは画面に表示されます。

```text
/kioku-typesafe-key <key>
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe` は固定の合成データに対する推論で、認証、要求したモデルへの送信、応答形式、正解を確認します。記憶や会話は送信せず、判定履歴も作りません。自動確認は判定可能な候補が初めて生じた時点で行います。起動時と候補ゼロの場合には通信しません。

`status` は通信せず、ローカルの認証設定と確認結果を表示します。`readiness.state` は `unconfigured`（未設定）、`unverified`（未確認）、`probing`（確認中）、`ready`（利用可能）、`unavailable`（利用不可）です。`checkedAt` は確認時刻、`reason` は失敗理由、`memoryReuse.active` は現在の利用可否です。成功は5分、失敗は30秒だけプロセス内で保持します。期限後の `unverified` は次回利用時に再確認します。同時の確認要求は共有し、キーの設定・削除、認証失敗で結果を無効化します。接続設定は依頼単位に固定され、新しい設定は次の依頼から適用されます。

Nimble は endpoint と model の明示が必要です。専用認証が必要なら `credentialRef` を設定します。TypeSafe のキーを流用せず、公開デモへの接続や provider の自動切り替えもしません。

```yaml
typedDecisions:
  provider: nimble
  nimble:
    endpoint: http://127.0.0.1:8000/v1/systemone
    model: your-served-model
    # credentialRef: NIMBLE_API_KEY
    acceptance:
      minProbability: 0.9
      minMargin: 0.2
```

## 選別と失敗時の動作

scope・適用条件・秘密情報の検査と、判定前の候補集合に対する権限確認を先に行います。未完了 intake、必須 capability 不足、記憶提供停止時には送信しません。送信する記憶は `renderMemoryFields()` による完全な投影だけです。途中切断で前提や否定を落とさず、大きすぎる候補は未判定にします。

| 判定 | 動作 |
| --- | --- |
| `applicable` | 優先配置。同じ判定内では元の順位を保持 |
| `not_applicable` | 今回の候補から除外 |
| `uncertain`・判定対象外 | 元の順位を保持 |

失敗の記憶も、回避策として役立つなら採用します。Choice では TypeSafe の confidence と Nimble の確率・margin を既存 adapter の別々の基準で処理します。Noul には confidence を流用しません。

TypeSafe は最大8候補、Nimble は1候補ずつ送ります。Noul でも候補ごとの3問を同じ part に収めます。同じ判定サービスを使う依頼間で、疎通確認を含め最大2要求を並行実行します。Nimble の token 上限はサーバーの判定に従い、バイト数を token 数とみなしません。個別の入力超過は未判定、通信・認証・形式エラーと全体期限切れは選別全体を既存検索に戻します。自動再試行は行わず、親タスクの取消を伝播します。権限・revision・整合性の不一致では停止します。

通常の開始・継続、Core、共通 intake を使う Deep／Enno 開始に適用します。Enno 途中の記憶更新には追加せず、`remoteCalls: 0` を維持します。API 待機中に DB transaction を保持しません。除外候補を含めた検索状態を待機後に再検証します。

同じ依頼・同じ入力の判定は保存済み履歴から再利用します。疎通確認の期限切れだけでは再課金しません。キー変更だけで同一入力を自動再試行することもありません。判定は元の記憶、信頼度、適用範囲を変更しません。新規の選別は `context-ranking-v9`、意味判定による除外は `semantic_not_applicable` として記録し、旧配信は従来どおり読めます。

## 検証

```sh
npm run test:memory-reuse
npm run test:evaluation:memory-reuse -- --mode=all
npm run test:evaluation
```

2番目は正解ラベルを返す mock adapter での配線検証です。日本語・英語、言い換え、否定、主体、実施済みと提案、成功と失敗、前提不一致の合成例を使います。baseline・Choice・Noul を同じ検索条件で比較し、scenario 単位で校正用と検証用に分けます。Noul の確率は1回の取得結果から指定した25組の閾値をオフライン比較します。`adoptionGate.status: unverified` は実モデル未検証を表します。mock の結果はモデル性能ではありません。3番目は従来の retrieval 評価です。

実モデルで測る場合は、評価用プロセスに認証・接続設定を明示してください。DSH の保存済みキーを探索・取り出す処理はありません。送信するのはリポジトリ内の合成例だけで、ユーザーの記憶 DB は読みません。

```sh
# TYPESAFE_API_KEY を安全な方法で環境へ設定してから実行
npm run test:evaluation:memory-reuse -- --probe --provider=typesafe --model=jev-1.13.0
npm run test:evaluation:memory-reuse -- --live --provider=typesafe --model=jev-1.13.0 --mode=all

# NIMBLE_ENDPOINT、NIMBLE_MODEL、必要なら NIMBLE_API_KEY を設定
npm run test:evaluation:memory-reuse -- --probe --provider=nimble
npm run test:evaluation:memory-reuse -- --live --provider=nimble --mode=choice
```

実モデル評価は設定不足なら失敗終了します。現行の合成例と mock の成功だけでは既定化条件を満たしません。実モデル評価は小さな合成サンプルであり、本番の精度を保証しません。参照記事の精度や閾値を kiokuko-dsh の実測として扱いません。

## Local Laya

[Laya-CoreML](laya-coreml.md) evaluates one complete record at a time through the
same service. An oversized record stays unassessed; if every record is oversized,
the selection falls back. Capacity/input failures do not make readiness unavailable.
No evidence is shortened to make it fit, and no TypeSafe/Nimble substitution occurs.
