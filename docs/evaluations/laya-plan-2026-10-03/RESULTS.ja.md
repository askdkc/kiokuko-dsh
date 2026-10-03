# Laya PLAN 実装・検証記録

## 判定

Akinator v3／Skill v2の限定統合と、Laya compactionの独立停止機構を実装した。
compactionはPLANの不採用ルートで終了する。既定値は `off`、`shadow` は変更をappendせず、
`auto` は `experimental_not_qualified` として推論・置換を拒否する。
ObservationPack、他providerのsemantic compaction、native summaryはそれぞれの設定を維持する。

検証資料はリポジトリ直下の `laya-workflow-validation.tar.xz`。
SHA-256は `a10468e05a5d92dd775af5c56c1b702daca7f4dd67e2e41624c426798b0c341d`。
PLAN記載の古い基準との差分を現在のcheckoutへ統合し、回帰比較は実装開始時の
`06c63b1f660301b1a8133656b00246682d7c6b5e` に対して行った。
アーカイブ、ユーザー設定、稼働中worker、ユーザーDBを変更していない。commit・pushはしていない。

## 実装範囲

| 工程 | 結果 |
|---|---|
| P0 | アーカイブの検証済みAkinator／Skill source hashと一致。現在HEADとの統合差分・最終source manifestを保存 |
| P1 | default/off/shadow/unqualified auto、cache迂回防止、handoff停止、native summary維持を実装 |
| P2 | 限定分類、棄権維持、明示回答優先、turn binding、最大4候補／任意1Skill、必須Skill維持を統合 |
| P3 | 可逆codec、10,000 round trips／500改ざん検査、共通native savings gate、exact tokenizer契約、評価用Dを実装 |
| P4 | `laya-lossless-task-v3` を1候補版として測定。LOSSLESS選択0/4のためno-go。閾値を緩めていない |
| P5 | 採用用の独立120件／200 tasksは未実施。C0〜C7はUNVERIFIED。採用用の下流oracle／bootstrap／600 quiet trialsを実装・実行済みとは扱わない |
| P6 | 最終直列検証・baseline比較・patch適用とhash照合は下記の検証結果に記録 |

`TargetTokenCounter` は完全なserialized request、route/serializer identity、tokenizer fingerprintを
受け取る非近似契約として実装した。今回のcapture routeには対象tokenizerがなく、`unsupported`。
実配備対象への接続を実装・検証済みとは扱わない。この状態でautoを許可しない。

## 実CoreML回帰

実行中の `aac6fef/laya-multilingual-coreml` とUnix socketを使用した。
runtime fingerprintは `sha256:da475625c9e3f9ab40020486b5ab8874b0e6d37d942f26022fb15964ce0cc1d9`。
macOS 27.0.1 arm64、Node 26.5.0。PLANのNode 24.19.0での再現ではない。
CPU結果とCoreMLの数値一致は主張しない。既存fixtureの再生であり、新しい独立holdoutではない。

| 対象 | 最終版で観測した結果 |
|---|---|
| Akinator 24件 | 正しい自動判定7、誤採用0。英語2／日本語5。残り17は質問を維持 |
| Skill 14件 | 必須14/14維持、関連任意8/10選択（英語5／日本語3）、不要な追加0 |
| Compaction 4件 | 候補prediction 4、readiness prediction 4。LOSSLESS 0、KEEP受理3、棄権1。shadow append 0 |

検証済み分類sourceは `40a0cf778c16a6f3347731cad6927b4387c707e6d17600d9b5b31f29955784b8`、
Skill sourceは `be5dc81c9e4bb71e90f1e9ce2ebaf5e67dade495a8332a11eaf0f47ceacf1c59` のまま。
debug/research/writing以外への自動化や、任意Skillの複数選択を追加していない。

実native DSH `0.1.5-rc.1` に同じsession ID・ツール定義・pending task/constraints・routeを渡した。
下流生成は要求capture用のscriptであり、タスク品質の実モデル試験ではない。

| 旧開発例 | O bytes / native推定 | D bytes / native推定 | L bytes / native推定 | L候補結果 |
|---|---:|---:|---:|---|
| cache EN | 15,182 / 2,999 | 3,609 / 495 | 15,182 / 2,999 | KEEP p=.9283 margin=.8696 |
| cache JA | 23,201 / 2,173 | 3,647 / 467 | 23,201 / 2,173 | 棄権 p=.8583 margin=.7464 |
| whitespace EN | 10,951 / 1,892 | 3,525 / 476 | 10,951 / 1,892 | KEEP p=.9145 margin=.8459 |
| whitespace JA | 12,177 / 1,572 | 3,553 / 456 | 12,177 / 1,572 | KEEP p=.9700 margin=.9458 |

native値は実際のtoken meterの推定値、bytesは実際のserialized request。対象tokenizerの正確なtokensではない。
Dの削減はLayaの成果に加算しない。Layaの下流改善を示す結果がないため、独立holdoutを消費しない。

## 採用gate

| Gate | 結果 | 未確認の証拠 |
|---|---|---|
| C0 | UNVERIFIED | 独立60系列／120 requests、200 task itemsの比較 |
| C1 | UNVERIFIED | 全holdoutと故障注入の100%完全性。ローカルround trip／mutation／native回帰は別に通過 |
| C2 | UNVERIFIED | 全holdoutのtoken arrays／collator出力の独立監査。回帰4件のstrict preflightは記録済み |
| C3 | UNVERIFIED | 実採用60/100・日英各30/50。回帰はLOSSLESS 0/4、shadowにcommitはない |
| C4 | UNVERIFIED | 対象tokenizerのexact全要求計測、L/D削減維持率 |
| C5 | UNVERIFIED | 実下流200 items×3回と事前固定oracle |
| C6 | UNVERIFIED | Dに対する10 items純増とpaired bootstrap |
| C7 | UNVERIFIED | quiet 600 trials、cache 100/100、実下流end-to-end計測 |

CLIの `verify` はこの状態でexit 1となる。未確認を合格に変換する機能はない。
現在のCLIはnative request captureを行う補助評価用であり、完全な採用認定器ではない。

## 再現と成果物

設定例:

```yaml
typedDecisions:
  provider: laya-coreml
  skillSelection: { mode: choice }
  laya-coreml:
    acceptance: { minProbability: 0.9, minMargin: 0.2 }
    skillAcceptance:
      policyVersion: laya-skill-shortlist-v2
      minProbability: 0.8
      minMargin: 0.2
    compaction: { mode: off, policyVersion: laya-lossless-task-v3 }
```

評価は新しい出力先を指定する。既存のrunを上書きしない。

```sh
node --import tsx scripts/replay-laya-workflows.mts .artifacts/NEW-workflow-replay
node --import tsx scripts/evaluate-laya-compaction.mts freeze \
  --policy evaluation/compaction-v1/acceptance-policy.json \
  --fixtures evaluation/compaction-v1/regression-capture.json \
  --oracles evaluation/compaction-v1/capture-oracles.json --out .artifacts/NEW-freeze
node --import tsx scripts/evaluate-laya-compaction.mts run \
  --manifest .artifacts/NEW-freeze/manifest.json --arms original,deterministic,laya --out .artifacts/NEW-capture
node --import tsx scripts/evaluate-laya-compaction.mts verify \
  --manifest .artifacts/NEW-freeze/manifest.json --results .artifacts/NEW-capture --out .artifacts/NEW-gates.json
```

raw wire、完全なrequest、原履歴、native surface、source/config manifest、gate report、全失敗実験は
リポジトリ直下の `.artifacts/laya-plan-2026-10-03/` に保存した。通常のpackageには含めない。
最初の `regression/` はO/DだけObservationPackツールが欠けた比較条件不一致として保存し、成果比較には使わない。
`regression-v2/` は比較条件修正後、`regression-final/` は本番dependency境界修正後の最終source。
prompt・採用thresholdは同じで、成績のよいrunだけを選んでいない。
`verification/` の全体テスト1失敗は孤立したtoken-costs moduleの境界検査で、修正後の結果と別に保存した。

## 最終検証

最終source freeze後、次の順序で直列実行した。

| 検証 | 最終版 | 実装前baseline |
|---|---|---|
| typecheck | PASS | PASS |
| focused decisions／semantic／handoff／intake | 242 pass、0 fail、0 skip | PASS |
| Python worker | 9 pass | 9 pass |
| `npm test` | 1,428 tests、1,271 pass、0 fail、157 skip | 1,400 tests、1,243 pass、0 fail、157 skip |
| build／publint／pack check／module tests | 全てPASS | 同じcommandsで全てPASS |
| Skill delivery | source・packed・native・protected Lispを通過 | 今回の追加検証 |
| protected Lisp suite | 94 pass、0 fail、14 skip | 今回の追加検証 |
| DSH 0.2.0-rc.2 native compaction／ObservationPack／handoff | 25 pass、0 fail、0 skip | 今回の追加検証 |

同一Node／依存での全体比較は新規失敗0。baselineの最初のsocket `EPERM` と
使い捨てcloneのremote設定不足による失敗も保存し、許可された同じ実行環境・正しいremoteでの
最終baselineとは区別した。157件のskipを通過とは数えない。
これらは異なるscopeの再実行を含むため、件数を合算してunique testsとは呼ばない。

最終検証のraw logsと機械可読結果は `.artifacts/laya-plan-2026-10-03/verification-final/`。
最終patchは実装開始時HEADの新しいclean cloneで `git apply --check` と適用を行い、
変更対象全ファイルのSHA-256を照合する。結果は同じartifactディレクトリの `patch-proof.json`。
GitHub CI、インストール済みpluginへの反映、稼働中DSH sessionへの更新はこのローカル検証に含まない。
