# 検証済み適用からの自動Global化

同じ候補・同じrevisionを、独立した3つの完了runで採用し、各runでホストが成功を観測した場合にGlobal記憶を生成します。`helpful`、関連性の推定、自己申告、過去のqualified pathだけでは数えません。親子runは1件として数えます。

同じrepositoryで3回成功した場合は、候補に明示された`applicability`が各runのadmission時のproject fingerprintに一致する必要があります。そうでなければ異なるrepositoryでの成功が必要です。同じrepositoryの別checkoutは別件にしません。Lispは実workspace直下で承認済みの`kioku.ci:verify`を実行し、対象が実行前後で変わらなかった場合だけ対象です。scratch検証とreplayは対象外です。

自動生成先は`source_verified`で、`auto_curator_globalize`の由来と元候補・revision・採用したrunを持ちます。手動Curatorの承認による`system_verified`とは別です。元候補・証拠・適用条件が失効した投影は配信時に除外され、workerが隔離状態を保存します。同じrevisionの隔離は自動解除しません。

標準で有効です。新しい昇格だけを停止するには、DSHのKiokukoプラグイン設定に次を指定し、DSHを再読み込みします。既存投影の配信時失効判定は継続します。

```yaml
- id: kiokuko-dsh
  config:
    autoGlobalization:
      enabled: false
```

`/kioku-memory-application status`に、現在の候補ごとの独立成功数、保留理由、生成先、隔離状態を表示します。`--json`で詳細を確認できます。設定を再び有効にすると、無効中に保留された候補を再評価します。
