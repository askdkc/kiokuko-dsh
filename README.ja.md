# Kiokuko DeepSeek Harness Plugin

[English](README.md) | 日本語 | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

`kiokuko-dsh`は、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)向けのout-of-tree Pluginです。
DeepSeek Harnessをforkまたはpatchせず、Cordis profileへKiokukoのmemory、Akinator intake、Enno-Oduno orchestration、検証境界を追加します。

このリポジトリはDeepSeek Harness Pluginのプロジェクトです。OpenCode Pluginではなく、Kiokuko本体のMCP導入ガイドでもありません。

## 導入

DeepSeek Harnessのソースcheckoutから、Node.js 24.16.0以上で`web` profileへ導入します。対象バージョンは`0.1.2-alpha.3`です。

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

削除する場合:

```bash
pnpm dsh plugin --profile web remove kiokuko-dsh
```

インストール済みの`dsh` CLIを使う場合は、`pnpm`を外して同じ引数で実行します。Pluginは`kiokuko-dsh`というbundle rowを1件だけ追加し、
他のPlugin、repository file、MCP設定、`AGENTS.md`は変更しません。

## 強制する境界

- exact bundled `kiokuko-soul`と6つの標準SkillをHarnessへ提供します。
- main model requestの前にAkinatorを実行し、intakeが未解決の間はモデルとKiokuko以外のtoolを実行しません。
- 14個のoperationを統合しますが、モデルへ公開するmodel-facing operationは7個だけです。intake、identity、確認、advisory、検証などはhost境界の内側に残ります。
- tool bodyの実行前にphase、run、revision、route、lease、idempotencyを検査します。
- DeepSeek `SessionEvent`をKiokuko ledgerへ順序とidempotencyを保って橋渡しし、model／tool dispatchと終了前にflush barrierを待ちます。
- Enno-Odunoの検証をturn-stoppingのhard gateにし、未完了または検証失敗時はcorrective stepを強制します。

## 正本と非対象

Kiokuko SQLiteはmemory、Akinator、Enno-Oduno state、receipt、lease、verifier evidenceのsemantic authorityです。DeepSeek `SessionEvent`は現在sessionの
順序付きmodel-visible transcriptとtool evidenceの正本です。外部Skillの自動install／execute、Git rollback、repository fileの自動変更、
continuation tokenのモデル公開は行いません。

OpenCode、Codex、Claude Code、Hermes Agent向けのKiokuko連携は、このリポジトリのPlugin対象外です。別のKiokuko本体のMCP／client setupを使います。

## 検証

```bash
npm run typecheck
node scripts/run-tests.mjs tests/dsh
npm run build
npm run pack:check
npm run test:e2e:dsh
```

`test:e2e:dsh`はin-memory compositionとpackage検査を常に実行します。実際のinstall／dump-config／removeは`dsh` executableがある場合だけ実行し、
ない場合はpassと偽らず`unsupported`を返します。

詳細は[DeepSeek Harness Pluginガイド](docs/dsh-plugin.md)を参照してください。

## License

MIT
