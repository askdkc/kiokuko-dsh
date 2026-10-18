# Kiokuko(記憶庫) DeepSeek Harness Plugin

记忆正文默认上限为 16,000 个 Unicode 字符，关系元数据有独立限额。请参阅[记忆传递预算](docs/memory-delivery.md)。

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 添加项目记忆、任务规划和验证支持。
AgenticReplay 可记录模型和工具活动，查看记录并导出 HTML。

记录正文默认使用 `capture.content: redacted`。若要尽量减少正文保存，可选择 `agenticReplay.capture.content: metadata`；不提供 raw 模式。已知凭据赋值、引号中的值、认证 header 和 URL 凭据会被移除，普通正文保留。这不能保证检测所有秘密，也不会修改过去的 trace 或 export；处理旧文件需要用户另行选择。
标准 DSH agent preset 提供 `subagent` 和 `subagent_fork`。普通子 agent 不会再次询问 Kiokuko 的执行模式。[配置说明](docs/dsh-plugin.md#subagents)。


新的修改任务可以选择普通执行或役小角(enno-oduno)。役小角支持推荐模板，也可从DSH已配置的模型中为各角色选择模型。[模型选择与连接限制](docs/model-selection.md)。

可选的[自动模型选择](docs/model-selection.md#automatic-model-selection)默认关闭（`modelAutoMode.mode: off`）。`/kioku-model-auto on | observe | off | status` 仅更改当前会话；`observe` 只记录建议，不更换模型。普通任务需要已就绪的 Jev 或 Laya、dsh-codex，以及 DSH 的模型元数据和 token meter。判定失败时保留当前模型，手动选择优先。

自动记忆审查默认启用：每完成八个人类输入回合，使用会话模型保存或更新有用的项目记忆候选，无需关闭会话。使用 `/kioku-memory-review status` 查看状态，或用 `/kioku-memory-review exclude session` 排除整个会话。[设置、费用和恢复](docs/auto-memory-review.md)。

ObservationPack 默认保持 `observationPack: { mode: auto }`。若完整行摘录无法保留任何原文，则不进行 pack，保留全文。已有 v1 pack 和 handle 仍可读取和恢复。

## 安装与使用

运行时兼容目标为 **DSH 0.2.1-alpha.2** 的 `web` 和 `dsh-cli` profile。请参阅[验证范围](docs/dsh-plugin.md#compatibility)。

需要 Node.js **24.16.0 以上**和 pnpm。
在 DSH 源码目录中首次安装并启动 Web 版：

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

首次安装并启动 CLI 版：

```bash
pnpm dsh plugin --profile dsh-cli add @askdkc/dsh-cli
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
pnpm dsh --profile dsh-cli
```

如果使用全局安装的 `dsh` CLI，请省略各命令中的 `pnpm`。
启动后直接输入任务，无需额外的 Kiokuko setup 操作。
GitHub 和本地安装方式见[插件指南](docs/dsh-plugin.md)。

AgenticReplay 的功能配置会自动安装，**无需手动设置**。每次聊天都会在无需确认的情况下记录详细日志。
记录后，后续模型回复和工具执行结果将保存到会话工作目录的 `.agenticreplay/runs/`。决定按会话保存，因此执行过 `/kioku-agenticreplay stop` 的聊天保持不记录。若想在聊天开始时确认，请设置 `agenticReplay.askOnStart: true`。

- `/kioku-agenticreplay start`：手动开始记录，或在停止后重新开始。若该聊天未被停止，则无需执行。不会补录过去的活动。
- `/kioku-agenticreplay status`：简要显示记录状态、保存位置和下一步操作。诊断详情可用 `/kioku-agenticreplay status --json` 查看。

用 `/kioku-agenticreplay stop` 完成日志记录后，用 `list` 查看 run ID、`show <run ID>` 查看内容、`export <run ID>` 导出 HTML（均在 `/kioku-agenticreplay` 后输入）。
要禁用记录，请设置 `agenticReplay.enabled: false` 并重新加载。详见[记录设置与命令](docs/agenticreplay-recording.md)。

## 更新

停止 DSH 后，更新并重启 Web 版：

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

停止 DSH 后，更新并重启 CLI 版：

```bash
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
pnpm dsh --profile dsh-cli
```

要更新到发布不足24小时的版本，请关闭 pnpm 11 默认的
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
检查，以更新 Kiokuko 及其依赖。确认第二条命令输出 `0` 后再执行更新：

```bash
pnpm config set --location=global --json minimumReleaseAge 0
pnpm config get minimumReleaseAge
pnpm dsh plugin --profile web update kiokuko-dsh --latest
```

此设置会保存到全局配置，后续 pnpm 安装和更新也会关闭发布时间检查。
更新成功后，请重启 DSH。

启动时会将包括日语输出在内的全部16个内置 Skill 及其引用文件同步到 `~/.agents/skills/`，创建缺失文件并更新受管理的副本，不覆盖非受管理文件。其他代理需要重新加载 Skill 目录。

以上是完整包的默认行为。[核心与可选模块构建](docs/core-modules.md)仅打包所选资源；核心可独立处理对话、调研、写作和项目记忆，不包含 Enno/Lisp 运行时。

启动时也会更新启动目录中 `AGENTS.md` 的现有 Kiokuko 管理块，保留块外的指令。更新包后请重启 DSH。其他工作目录或旧副本的检查与修复请参阅[设置步骤](docs/dsh-plugin.md#what-setup-updates-and-when)。`kiokuko use` 不是 DSH 的设置命令。

`agenticreplay` 包的版本范围为 `>=0.1.0 <1.0.0`，后续补丁和次版本可在不修改范围的情况下更新。
锁文件会保留已验证的版本，直到明确更新依赖。更新后请重启 DSH。
从 OrcaReplay 升级时，请将显式 `orca` 配置改为 `agenticReplay`；
已保存的记录选择和旧日志会保留，但旧日志不会导入。
[更新详情](docs/dsh-plugin.md#update) · [记录功能迁移](docs/agenticreplay-recording.md#upgrade-from-orcareplay)

DSH 更新后若无法加载 Kiokuko，请参阅[启动恢复步骤](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)，按对应 profile 更新或重新安装。请保留会话日志和 Kiokuko 数据库；重新安装不一定能解决 API 兼容性问题。

[文档](docs/README.md) · [权限](PERMISSIONS.md) · [MIT 许可证](LICENSE)

## 可选代码分析

`kioku.code` 通过 `@askdkc/dsh-lsp-server`，在 Lisp 中读取代码结构和只读 LSP 结果。
请在 `kiokuko-dsh` 所用的同一 profile 中安装或更新。CLI 版请将 `web` 替换为 `dsh-cli`。

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

详见[设置、支持的语言和限制](docs/code-intelligence.md)。
