# 実行方式とモデル構成

新しい実装・変更、デバッグ、レビュー、運用作業では、DSHの質問画面で
「通常実行」か「役小角を使う」を選びます。READMEの修正でも通常実行を
選択できます。「役小角を使わずREADMEを修正」のように明示すると、利用選択を
重ねて質問しません。雑談と、既存の役小角対象外の調査・文章作成では質問しません。

通常実行は現在のDSHモデルで進みます。Kiokukoの記憶、適用されるSkill、
DSHの権限判定、必要な検証を維持し、役小角の契約・WorkUnit・計画承認・
自動継続を作りません。継続・再試行・再計画は同じ論理作業の選択を引き継ぎます。
取消・未回答では作業を保持します。再開の入力後に選択を続けられ、最初の依頼も復元します。

## おすすめテンプレート

| グループ／テンプレート | enno-ideal・Zenki | Gokiヘッド | 子 | enno-check・振り返り |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-6-astra` | `gpt-5.6-sol` | `gpt-5.6-luna` | `gpt-6-astra` |
| OpenCode Go・GLM | `glm-5.3` | `glm-5.3` | `glm-5.3-flash` | `glm-5.3` |
| OpenCode Go・Qwen | `qwen3.8-max` | `qwen3.8-max` | `qwen3.8-flash` | `qwen3.8-max` |
| OpenCode Zen | `glm-5.3` | `glm-5.3` | `glm-5.3-flash` | `glm-5.3` |
| OpenRouter・GLM | `z-ai/glm-5.3` | `z-ai/glm-5.3` | `z-ai/glm-5.3-flash` | `z-ai/glm-5.3` |
| OpenRouter・Qwen | `qwen/qwen3.8-max-0902` | `qwen/qwen3.8-max-0902` | `qwen/qwen3.8-flash` | `qwen/qwen3.8-max-0902` |
| Ollama・ローカル標準 | `qwen3-coder:30b` | `qwen3-coder:30b` | `qwen3-coder:30b` | `qwen3-coder:30b` |

これらは版1の構成候補です。適用時にDSHの登録モデルと正確なIDで照合します。
表示名の部分一致による代用はありません。全テンプレートを表示し、適用可能、
接続未設定、モデル不足、互換性の確認が必要、を区別します。

テンプレートを選び、実際のDSH接続へ結び付け、役割別の構成を確認して開始します。
接続IDは固定しません。同名の接続やモデルもIDを併記して区別します。
OpenAI APIとCodex認証、OpenCode GoとZenは別の接続として扱います。
接続先の種類・通信方式が未登録なら、DSHに設定した内容を質問画面で確認します。
Kiokukoは認証情報を取得・変更しません。

「DSHに設定済みのモデルから選ぶ」経路では、接続別一覧、自由入力による検索、
ページ送り、他の役割からのコピーを使えます。DeepSeek Flashなども登録済みなら
選択できます。テンプレート採用後の変更は「カスタム」と表示し、元テンプレートの
IDと版を保持します。戻る・取消でも設定途中の構成は保持されます。

reasoningはモデルの既定値です。Ollamaを含む構成は子の同時実行数を1に制限し、
モデルのダウンロードは行いません。カタログ登録は契約や利用枠の保証ではありません。
認証・利用上限・モデル利用不可のエラーでは自動代替せず、次の要求に使う構成を
再選択します。既に完了した編集やツール呼び出しは再実行しません。

## 接続設定と互換性

接続の対応付けをあらかじめ登録する場合は、Kiokukoのプラグイン設定に指定できます。
DSH自体の接続・認証設定を変更する項目ではありません。

```yaml
modelRoutes:
  - provider: my-openai-api
    family: openai
    connection: api
    protocol: responses
  - provider: my-local-models
    family: ollama
    connection: local
    protocol: chat-completions
```

`family` は `openai` / `opencode-go` / `opencode-zen` / `openrouter` /
`ollama` / `other`、`connection` は `api` / `codex` / `local`、
`protocol` は `responses` / `chat-completions` / `messages` / `unknown` です。
設定と画面による申告は通信成功の証明ではありません。AstraはResponsesと確認された
接続だけに割り当てられます。設定が実際の通信方式と違えば実行時に失敗します。

**DSH 0.1.2-rc.1の標準pi-ai Chat Completions経路では、Goの利用開始を保留します。**
対象版の実アダプターを記録用HTTP応答につないだ試験では、親・子・補助要求の
`x-deepseek-harness-session-id` が欠けます。Goテンプレートは表示されますが、
この経路を「適用可能」と表示しません。カスタム構成でも同じ判定を適用し、
Zenへ切り替えません。別アダプターの対応を確認したホストは、
`dshModelCompatibility.inspect(binding, route)` で通信方式と親・子・補助要求の
セッションヘッダー送信の検証結果を提供できます。UIの回答では検証済みに変更できません。
この拡張サービスは標準DSHが提供するサービスではなく、対応アダプターを管理するホスト用です。

## 実行と復旧

選択方式・構成・元テンプレートの版・通常会話モデルを論理作業に保存します。
テンプレートの更新は進行中の構成を変更しません。親は公開されたエージェント単位の
プロンプト組み立て／要求フックを使い、一つの要求で同じ構成を使います。
Webの既定モデルを保存する `selectModel()` は使用しません。終了後は通常モデルへ戻します。

Gokiは `enno_delegate` に `instruction` を渡せます。ホストが現在の承認済み
WorkUnit・lease・構成を検証し、DSH内の `spawn` を使います。子は初回要求前に
委譲と結び付けられ、子で役小角を開始したり孫を作ったりできません。
初期版の子はWorkUnit内の変更をファイル操作で行い、コマンドと検証器の実行は
Gokiヘッドが担当します。子の完了はWorkUnitの受理を意味しません。
Gokiが結果を確認し、既存の `enno_work_report` で報告します。
中断された委譲は不確定として保持し、同じ呼び出しを自動で再実行しません。
子の同時実行数は保存済み状態から判定し、再起動で制限をリセットしません。
子の要求とファイル操作の直前にも現在のleaseを検証します。プロセスの強制終了で
委譲が実行中のまま残った場合は、その子の記録を確認するまで新たな委譲を制限します。

既存の助言枠、最終検証、記憶確定、Orcaの記録契約を維持します。
実アカウントでの課金・契約・利用枠の試験は行っていません。
native試験は親子のモデルIDと接続経路を検証し、プロバイダーでの実利用成功を保証しません。

DSHの実装根拠は対応版の
[モデル選択フック](https://github.com/deepseek-ai/deepseek-harness/blob/a66e4702047846cdaa10c66c9d3df3951f5ea70d/packages/core/agent/src/model-selection.ts)、
[要求ループ](https://github.com/deepseek-ai/deepseek-harness/blob/a66e4702047846cdaa10c66c9d3df3951f5ea70d/packages/core/agent-loop/src/agent.ts)です。
