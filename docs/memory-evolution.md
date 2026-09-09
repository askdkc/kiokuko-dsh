# Episode / evolution

一つの Kiokuko run を一つの経験（episode）として残し、条件が揃った経験から検索用の教訓候補を作ります。既存の終了後要約に構造化抽出を加え、検索本文は従来の `entries` に保存します。

**初期設定の `active` では、根拠が有効な episode 概要・教訓・失敗回避策を検索と自動注入に使います。** 新しいセッションでも同じ workspace の候補を参照できます。全候補は未検証のまま扱い、独立した支持・証拠・revision の検査を満たす必要があります。実モデルでの改善率は未測定です。評価結果の有無によって設定を強制的に `observe` へ変換する処理はありません。

## 設定と状態確認

DSH の Kiokuko プラグイン設定に追加します。設定変更後は DSH を再読み込みしてください。

```yaml
- id: kiokuko-dsh
  config:
    memoryEvolution:
      mode: active
      dailyCalls: 8
      maxInputBytes: 32768
      maxOutputTokens: 2048
      timeoutMs: 60000
```

```text
/kioku-evolution status
/kioku-evolution status --json
```

`active` は根拠が有効な未検証候補を検索・自動注入の対象にします。`observe` は生成・評価のみ、`off` は新規 episode 抽出・教訓生成・派生候補の検索を停止します。`off` でも既存データと通常記憶は残ります。同じ DB を共有するホストの設定変更は、DB 内の設定世代と検索状態にも反映されます。以前の実装で `active` が強制的に `observe` になっていた DB も、更新後のホスト起動時に設定へ同期します。保存済みの有効な候補は再生成せず利用します。明示的な `observe` / `off` は維持します。

状態表示は、要求／実効モード、episode 数、生成ジョブの待機・処理中・完了・保留・失敗、見送り理由、追加呼び出し数、報告された token 使用量、生成時間を含みます。未報告の使用量はゼロ扱いしません。状態表示とジョブの失敗理由には候補本文・モデルのエラーメッセージ・秘密情報を出しません。

上限は引き下げ可能です。1 run あたり追加呼び出し1回、UTC 日付単位で workspace あたり8回、入力6 episode / 32 KiB、出力2,048 tokens、60秒、ホスト内同時実行1件を超えません。モデルは終了後要約の provider / model を保持し、代替モデルへ切り替えません。コンテキスト容量が不明、または容量内で支持条件を満たせなければ保留します。

## 抽出と採用条件

- 対象は `completed` と、native checkpoint 後の開始・終了 seq が確定した `failed`。`cancelled` / `interrupted` は対象外です。failed の範囲が欠けるときは理由を残して見送ります。
- capsule v2 は通常記憶と episode を同じ要約呼び出しで返します。全体64 KiB、重要な出来事は最大6件です。既存の v1 ジョブは v1 のまま処理します。episode だけが不正なら、通常記憶の保存は続行します。
- 証拠は対象 run の native ログからホストが提示した seq のみに限定します。ツール結果は同じ範囲内の call ID と結び付けます。plugin 由来メッセージ、記憶・制御ツール、assistant の成功宣言を根拠にしません。
- 成功の判定には、操作後に観測されたツール結果の明示的な数値 `exitCode` / `exit_code = 0` が必要です。標準 bash のように表示本文へ終了コードを出さないツールでは、ホストが最終 `tools/result` の構造化値を読み、本文を含まない `kiokuko/evolution-observation` イベントを native ログへ追加します。run・workspace・session・call seq・最終表示内容 hash を照合し、timeout / abort を成功扱いしません。汎用の自然言語出力だけのツールは成功未確認になります。ツールごとの結果形式を広げる場合は、その native 形式を固定したテストを追加してください。
- 永続化する証拠は seq・種類・結果区分・正規化内容 hash です。観測本文は抽出時だけ使い、別の詳細ログとして複製しません。構造化 episode と短い検索概要は残ります。
- signature は workspace とエラー・ツール・対象・バージョンの正規化値で決定します。`unknown` を含むものは教訓生成へ進めません。同じ run、同一 session の重複範囲、同じ正規化根拠は独立した支持に数えません。
- 通常の教訓には独立した3 episode と、うち2件以上の観測された成功が必要です。生成を予約した後は、新しい独立 episode がさらに3件増えるまで再生成しません。
- 失敗回避策には具体的な発生条件・避ける操作・観測済みの代替または診断手順・確認方法が必要です。具体的なユーザー訂正、または失敗→代替操作→再検証の順序が揃えば1 episode から採用可能です。それ以外は独立した失敗2件以上が必要です。

初期アルゴリズムの生成は**観測済みの文言の選択・整理**に限定します。LLM が書き換えた未観測の手順は採用しません。相互に異なる手順は、安全側に保留します。意味的には同じ手順でも表現差で保留されることがあります。この制約の緩和には別の品質評価が必要です。

全ての派生記憶は project-only の `candidate / untrusted` です。verified、Global、Skill へ自動昇格しません。成功事例との関連を因果関係の証明として扱わず、単発の訂正・回復と複数回の支持を本文で区別します。

## 永続化・復旧・検索

migration 012 だけを追加しています。過去の migration や entry を書き換えず、既存データの一括再要約もしません。episode、派生 revision の出典、生成ジョブ、呼び出し予算を既存 SQLite に保持します。

派生 revision は、元 entry の revision / 内容 hash、episode、アルゴリズム版と結び付きます。元記憶や episode 概要の変更・削除・supersede、該当 revision の `stale` / `conflicting` feedback により、派生記憶は検索時に不適格になります。設定と適格性は context の状態 hash に含め、選択後の変更も注入前に検出します。

生成は通常の記憶保存がコミットした後に実行する別ジョブです。モデル呼び出しは transaction の外、予算予約と採用は transaction の中で行います。採用直前に claim token・attempt・有効期限・設定世代・根拠 revision を再確認します。

一つのジョブは最大2回 claim できますが、**既に送信したモデル要求は再送しません**。送信後のクラッシュや timeout では結果が不明になり得るため、1 run あたり1呼び出しという上限を優先して保留／失敗にします。未送信の期限切れ claim は再取得できます。応答が遅れて戻っても、期限切れや設定変更後に候補を保存しません。

字句検索・意味検索・連合検索・自動注入は同じ派生記憶の適格性判定を使います。検索時の追加 LLM 呼び出しはありません。自動注入は同じ episode 由来を原則2件までにし、空いた枠は他の経験で埋めます。同じ根拠の教訓と episode 概要が両方ヒットした場合は、教訓を残して概要の重複を省きます。概要が先に枠を埋めて教訓を排除しないための処理で、支持数による検索スコアの加点は行いません。完全一致の識別子検索と通常の明示検索にはこの件数制限を適用しません。

## 検証と実モデル評価

```bash
npm run test:evolution
npm run typecheck
npm test
npm run build
npm run publint
npm run pack:check
npm run test:evaluation:evolution
```

最後のコマンドは接続設定なしでは `unmeasured` を返し、モデルを呼びません。実評価では固定したモデルを提供する OpenAI 互換 endpoint を明示します。次の JSON のモデル名・revision・次元数・容量は、実際に提供している値へ置き換えてください。

```json
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "model": "YOUR_PINNED_LLM",
    "revision": "YOUR_IMMUTABLE_REVISION",
    "contextWindow": 131072
  },
  "embedding": {
    "baseUrl": "http://127.0.0.1:8001/v1",
    "model": "YOUR_PINNED_EMBEDDING_MODEL",
    "revision": "YOUR_IMMUTABLE_REVISION",
    "dimensions": 384
  },
  "distanceCeiling": 0.5,
  "allowRemote": false
}
```

```bash
npm run test:evaluation:evolution -- --config evolution-evaluation.local.json --output evolution-evaluation-results
```

必要なら各モデルに `apiKeyEnv` を指定し、その環境変数に credential を渡します。endpoint URL や結果ファイルには含めません。remote endpoint の利用には `allowRemote: true` が必要です。このコマンドは最大90件ずつの通常要約と v2 要約、上限内の追加生成、実 embedding を実行します。モデルによって時間・費用が発生します。評価用データ以外のセッションや既存 DB は使用しません。

`tests/fixtures/evolution-evaluation/manifest.json` が30シナリオ・90 episode・120質問の hash と分割を固定します。10シナリオが調整用、20が固定評価用です。「現状」「episode のみ」「教訓まで」「全機能」を同じモデル・距離閾値・8,000文字の注入予算で比較します。旧来の人工ベクトル評価は別の回帰テストとして残しています。

`report.json` は Recall@5、完全一致の順位劣化件数、同一経験の3件目以降による注入文字数、scope 混入、根拠失効後の注入、呼び出し数、報告された token、生成／embedding／検索時間を出力します。日次8回の生成上限は評価でも維持します。モデルの返す名前は一致検査しますが、endpoint の実際の重み revision は運用者側で固定・記録する必要があります。

存在する証拠参照だけでは内容の正しさは証明できません。`candidates.json` を人が確認し、全候補について根拠のない成功断定がないことをレビューします。レビュー結果は次の形式です。

```json
{
  "artifactHash": "report.json に記載された artifactHash",
  "fixtureHash": "manifest.json に記載された sha256",
  "reviewedEntries": 0,
  "unsupportedSuccessClaims": 0
}
```

`reviewedEntries` は実際に確認した全候補の件数へ置き換えます。既に測定した結果にレビューを適用するため、モデルを再実行する必要はありません。

```bash
npm run test:evaluation:evolution -- --report evolution-evaluation-results/report.json --review evolution-review.json
```

固定評価では Recall@5 が現状比5ポイント以上改善、完全一致の順位劣化ゼロ、重複による注入文字数30%以上削減、別 workspace・失効した教訓の注入ゼロ、全候補の成功断定レビュー通過を品質目標とします。レポートの `eligibleForActive` はこの品質目標への到達を表す評価項目で、実行時の設定を変更しません。品質比較を行う場合は明示的に `observe` を選択できます。測定前に改善率を主張しません。

## 参照元

Memmy の commit [`98146714aad8569a298cf8692946da8bb28bf7cb`](https://github.com/MemTensor/memmy-agent/tree/98146714aad8569a298cf8692946da8bb28bf7cb) にある episode / policy induction、reflection、negative experience を設計の参考にしました。

- [episode・経験からの手順生成](https://github.com/MemTensor/memmy-agent/blob/98146714aad8569a298cf8692946da8bb28bf7cb/Memory/src/algorithm/plugin-algorithms.ts)
- [reflection](https://github.com/MemTensor/memmy-agent/blob/98146714aad8569a298cf8692946da8bb28bf7cb/Memory/src/service/evolution/span-pipeline.ts)
- [失敗経験](https://github.com/MemTensor/memmy-agent/blob/98146714aad8569a298cf8692946da8bb28bf7cb/Memory/src/service/evolution/negative-experience-pipeline.ts)

上流は MIT License、Copyright (c) 2026-present MemTensor。本実装は Kiokuko の境界に合わせた独立実装で、上流のコード・プロンプトは複製していません。階層ストア、共有 namespace、独立サーバー、エージェント制御、報酬逆伝播、時間減衰は導入していません。
