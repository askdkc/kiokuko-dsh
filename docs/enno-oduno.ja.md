# 役小角(enno-oduno)

![役小角(enno-oduno)](../skills/kiokuko-enno-oduno/enno-oduno.png)

build、debug、review、devopsでは、Enno-Odunoがrun-bound loopを管理します。

```text
intake → ideal → plan → 確認 → WorkUnit実行 → 最終検証 → meditation
```

現在のDSH sessionをbindし、Akinatorのintakeを解決し、理想の結果を保存してから、revision-bound planをZenkiへ渡します。
Zenkiは変更を責務と理由が1つのWorkUnitへ分割し、Gokiは承認済みunitだけを実行します。unitにはcode/ui/test/docs/operationsのローカルrouteがあります。

確認画面にはscope、除外、完了条件、Skill、expertise、command、timeoutを、元の依頼から判定した英語または日本語の構造化Markdownで表示します。
path、command引数、identifier、timeoutの正確な値は変更しません。外側のcard titleとbuttonはDSH UIのlocaleが所有し、Kiokukoが所有するのはMarkdownのplan本文だけです。内部IDやraw JSONは表示しません。

plan環境が欠落・変更した場合、discovery、plan保存、実装の前に停止し、continue/review/restart/cancelを選びます。継続は短命のroute-epoch-bound resume tokenと
単一ownerのexecution leaseを使い、期限切れleaseだけ安全に回収できます。曖昧なrunはrerouteしません。

WorkUnit実行中にDSHのmodel requestが失敗しても、Kiokukoは中断されたmodel処理やtool処理を自動再送しません。次のuser turnで、同一DSH session、revision、WorkUnitを再検証してからexecution leaseを更新し、旧leaseが失効した後でも同じrunを再開します。

Final Reviewはshell無効・repository相対pathでverifierを実行し、contract/mutation revision、verifier仕様、repository stateにevidenceを束縛します。
完全なpass evidenceだけを`enno_finish`が受理します。失敗時はGokiへ直接戻らず、Zenkiが新revisionで再計画します。受理後はread-only meditationで削除候補を記録するだけです。

ideal、planning、final-reviewでは、親hostが最大3つの隔離read-only Advisory Round slotを使えます。Kiokuko自身はadvisorを起動せず、隔離を確認できないslotはunavailableになります。

## 実行中の記憶更新（任意）

新しいエラー、WorkUnitの対象、ユーザー条件を、次の安全なモデル要求境界で記憶検索に反映します。
通常のpreStepと永続boundary workerのcontext工程で同じ処理を使います。初回のintake検索、計画承認、実行lease、最終検証は維持します。

```yaml
- id: kiokuko-dsh
  config:
    ennoMemory:
      mode: active
      maxFullSearchesPerRun: 8
      localBudgetMs: 1000
      rerank: false
    efficiency:
      observe: true
```

| 設定 | 初期値 | 動作 |
| --- | --- | --- |
| `mode` | `off` | `off`: 追加処理なし。`observe`: 判断のみ観測。`active`: 差分に応じて追加検索 |
| `maxFullSearchesPerRun` | `8` | 初回とは別の追加検索上限。1〜32。失敗・再起動・別ホストでも予約分を返金しない |
| `localBudgetMs` | `1000` | 100〜5000 msの協調的な経過時間予算。超過した結果は採用しない |
| `rerank` | `false` | 再順位付けは未採用。`true`は設定エラー |

検索が成功した後は、同じ意味のエラーを別call IDで観測しても追加検索は増えません。失敗した検索の次境界での再試行もrunの上限に計上します。役割やrevisionだけの変更では検索せず、選択済み記憶を現在の状態に結び直します。
新しい根拠やcorpusの変更時は、既存の連合検索で候補を取り直します。提示内容が圧縮で消えた場合は、有効性を検査して再提示します。

観測は現在のrun/sessionと実際のtool callに束縛できる最終結果、およびホストが保存したverifier結果だけを使います。
文字列の走査は1結果8 KiB、検索信号は最大16件・各192文字です。子エージェントへの自動配送は追加しません。

`observe`は追加検索、embedding、context差し替え、DB・feedback書込みをしません。`efficiency.observe: true`で数値と列挙値の観測を取得できます。
新しい本文ログは作りません。既存の検索状態hashの計算費用も経過時間に含まれ、corpusが大きいほど費用は増えます。
同期SQLite処理を設定時間ちょうどに強制停止する仕組みではありません。

現在の標準DSHホストはembeddingをoffで渡すため、この追加検索は字句検索で動きます。追加LLM・remote embedding呼出し、モデルの自動ダウンロードはありません。
必須embeddingを満たせないホストでは追加記憶を省略します。元の作業の権限や検証条件は緩和しません。

cold resumeでは古いdeliveryを復元しません。`off` / `observe`は従来どおりcontextなし、`active`は現在の権限と予算で新規検索します。
無効化するには`mode: off`に変更します。進行中の結果と追加選択を失効させ、現在検査できる初回記憶だけを残します。
記憶の削除・supersede・適用条件変更は送信直前にも検査します。予算切れや任意検索の失敗でも、元のユーザー入力を維持します。

実モデルの品質向上・token削減は未測定です。[評価方法と結果](enno-memory-evaluation.md)を参照してください。
