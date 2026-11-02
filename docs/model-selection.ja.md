# 実行方式とモデル構成

新しい実装・変更、デバッグ、レビュー、運用作業では、DSHの受付（Akinator）後に
「通常実行」で進めます。READMEの修正も同じ通常実行です。雑談や調査・文章作成は
通常流れです。継続・再試行・再計画は同じ論理作業として引き継ぎます。
取消・未回答では作業を保持し、再開の入力後に継続できます。

通常実行は現在のDSHモデルで進みます。Kiokukoの記憶、適用されるSkill、
DSHの権限判定、必要な検証を維持します。別個の契約・WorkUnit・計画承認・
自動継続は作りません。

## 通常実行のモデル自動選択

Webプロファイルでは [Kiokuko Models](kiokuko-models.md) から接続を設定できます。DSH本体のModelsで設定する必要はありません。登録したモデルは、通常会話・Deepでネイティブ接続と併用できます。

通常版・modular coreとも `modelAutoMode.mode: off` が既定です。同じDSHプロファイルでKiokuko Modelsまたはdsh-codexからCodexを認証し、Jev・Laya・[OpenAI](typed-decisions.md#openai-credentials)のいずれかの判定を準備したうえで、まず `observe` で選択案を確認します。

```yaml
modelAutoMode:
  mode: off # off | observe | auto
  preset: codex-luna-sol-v1
  budgetMs: 5000
```

```text
/kioku-model-auto observe
/kioku-model-auto status
/kioku-model-auto on
/kioku-model-auto off
```

コマンドは現在のnativeセッションだけを変更します。`on` は手動のモデル指定も解除します。DSHのpickerでモデルを手動選択すると、同じセッションで `on` を再実行するまで手動指定が優先します。変更は次の新しいタスクから反映し、送信済みの要求を途中で切り替えません。`/kioku-decisions status` にも同じ状態を表示します。設定を `off` に変更してDSHを再起動すれば、保存済みのセッション指定も無効になります。

初期候補は `gpt-6-luna` の low・medium・high と `gpt-6-sol` の high です。`modelAutoMode.routes` には最大4件、`id`（`luna-low`、`luna-medium`、`luna-high`、`sol-high`）と `binding`（`provider`、`model`、`reasoningEffort`）を指定できます。IDは経路のラベルなので、登録済みのAstraなども正確なbindingで割り当てられます。候補はCodex由来とResponses方式を確認でき、現在のモデル一覧、文脈容量・入力形式・推論強度、要求設定の検証、token meterを通った接続に限定します。ネイティブの `openai-codex` とKiokuko所有のCodex接続が対象です。名前だけを似せた接続やOpenAI API接続は対象外です。有効なbindingが2件未満なら判定しません。

新しい受付済みの通常タスクでは、現在の依頼文、タスク種別、添付の種類、経路IDと判定基準を選択中のJev・Laya・OpenAIへ送ります。この判定のために添付の内容、全履歴、リポジトリ全体は送信しません。Choice 1問の結果をrunに保存し、継続では同じ経路を使います。再起動時に判定結果が不明なら再送せず元のモデルを維持します。`observe`、棄権、probe失敗、metadata不足、非対応effort、timeout、入力超過でも元のモデルを維持します。取消、セッション同一性の不一致、保存の整合性エラーでは要求を止めます。認証・利用枠・モデル利用不可によるdispatch失敗を別モデルへ自動再送しません。

状態表示では、設定・準備状態・選択案・適用したbindingと、nativeの `request/header` で確認した実モデルを区別します。初期候補は判定基準であり、品質・時間・利用枠の改善を保証しません。Deep、子、雑談、回答の再検討、保護されたLisp実行は既存の経路を使います。実装失敗後の自動昇格は初期版に含めません。

### モデル選択の評価と判定キャッシュ

ソースのチェックアウトでは、認証情報や外部の判定サービスを使わずに評価経路を確認できます。

```text
npm run test:evaluation:model-routing
```

設定したJevかLayaで日英16件の固定ケースを評価する場合は、live実行を明示します。

```text
npm run test:evaluation:model-routing -- --live --provider jev --config PATH
npm run test:evaluation:model-routing -- --live --provider laya --config PATH
```

`PATH` には `typedDecisions` と同じ形式のJSON設定ファイルを指定します。Jevには版を固定した `typesafe.model` と `TYPESAFE_API_KEY` が必要です。Layaは起動済みのworkerを使います。live実行は準備状態のprobeを含む判定リクエストを送りますが、生成タスクの開始や現在のセッションのモデル変更はしません。`--repetitions 1..10`（既定1）、`--seed UINT32`（既定0）、`--output PATH` で反復とJSON出力を指定できます。offlineの結果は評価経路の確認だけを表し、`quality: null` と表示します。liveの結果も固定ケースと現在の判定基準との一致を測るもので、実作業の品質、費用、providerのキャッシュ節約を証明しません。Laya v1では入力が完全に処理されたか確認できません。

共有の判定サービスは、保存データから再取得できる完了済みの要求設定と結果を、それぞれ最大256件だけメモリに保持します。保存済みの判定は削除しません。通常実行とLispの `kioku.decisions:*` が使う判定に適用されます。モデル自動選択とこの評価は通常実行が対象です。

選択カードでは数字キーで選び、Enterで送信できます。10番以上は数字を続けて入力します
（例：`1`→`2`→`Enter`で12番）。Backspaceで番号を訂正できます。
検索欄に入力中の数字は検索語として扱い、Enterで検索します。IME変換中のEnterや
キーの長押しでは選択・送信しません。

## ヘッド／ワーカー構成

実行方式の質問では、現在のDSHモデル（`通常実行`）か、固定の
**GPT-6.1-Sol ヘッド + DeepSeek V4.1 Flash サブエージェント**のペアを選べます。
ペアは両方の正確なモデルIDを実登録一覧で検証した後に採用し、モデルの自動代替は行いません。
ペアは論理作業ごと、またはセッションごとに保存され、実行中の構成を書き換えません。
エージェント単位の組み立て／要求フックが一つの要求で同じ構成を使い、
終了後は通常モデルへ戻します。

OpenAIの割り当ては [OpenAIのモデルガイド](https://developers.openai.com/api/docs/models) に基づく
**gpt-6.1-sol**（ヘッド）と **gpt-6.1-luna**／DeepSeek **V4.1 Flash**（サブエージェント）です。
Codex接続では dsh-codex の登録IDを用います。プロバイダー・モデルの正確なIDを
DSHに渡し、表示名の部分一致による代用はありません。

DSHがプロバイダーの認証・通信・モデル検証を所有します。認証・利用枠・
モデル利用不可のエラーでは自動代替せず、次の要求に使う構成を再選択します。

## 保存と復旧

選択方式・通常の接続・元テンプレートの版・通常会話モデルを論理作業に保存します。
テンプレートの更新は進行中の構成を変更しません。Webの既定モデルを保存する
`selectModel()` は使用しません。終了後は通常モデルへ戻します。

実行所有権は1つの `mode` に固定され、別の実行系が同じセッションの所有権を
奪う構成では競合として扱います。現行仕様に合わない保存済みの選択は、
静かに読み替えず明示的な再選択を求めます。

native試験は依頼の実行、取消・再読み込み、入力復元、独立セッション、
ルーティング復帰、実際のアダプター経路を検証します。記録アダプターは
プロバイダーでの実利用・課金・利用枠を保証しません。記憶確定と
AgenticReplayの記録契約はこれまでどおりです。
