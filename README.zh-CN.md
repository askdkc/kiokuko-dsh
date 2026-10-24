# Kiokuko(記憶庫) DeepSeek Harness Plugin

记忆正文默认上限为 16,000 个 Unicode 字符，关系元数据有独立限额。请参阅[记忆传递预算](docs/memory-delivery.md)。

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 添加项目记忆、任务规划和验证支持。
AgenticReplay 可记录模型和工具活动，查看记录并导出 HTML。

记录正文默认使用 `capture.content: redacted`。若要尽量减少正文保存，可选择 `agenticReplay.capture.content: metadata`；不提供 raw 模式。已知凭据赋值、引号中的值、认证 header 和 URL 凭据会被移除，普通正文保留。这不能保证检测所有秘密，也不会修改过去的 trace 或 export；处理旧文件需要用户另行选择。
标准 DSH agent preset 提供 `subagent` 和 `subagent_fork`。普通子 agent 不会再次询问 Kiokuko 的执行模式。[配置说明](docs/dsh-plugin.md#subagents)。


新的修改任务可以选择普通执行或役小角(enno-oduno)。役小角支持推荐模板，也可从DSH已配置的模型中为各角色选择模型。[模型选择与连接限制](docs/model-selection.md)。

可选的[自动模型选择](docs/model-selection.md#automatic-model-selection)默认关闭（`modelAutoMode.mode: off`）。`/kioku-model-auto on | observe | off | status` 仅更改当前会话；`observe` 只记录建议，不更换模型。普通任务需要已就绪的 Jev 或 Laya、dsh-codex，以及 DSH 的模型元数据和 token meter。判定失败时保留当前模型，手动选择优先。

记忆功能是可选的。任务结束后，Kiokuko 会询问是否整理记录的经验，显示临时预览，并且只保存用户批准的确切修订版本。自动记忆写入已停用。[审查、回忆与遗忘](docs/replay-memory-review.md)。

使用 `/kioku-memory explain ENTRY_ID` 查看来源和更正；使用 `/kioku-memory forget ENTRY_ID --revision N` 明确遗忘一条记忆。[证据、解释与遗忘](docs/memory-evidence.md)。

ObservationPack 默认保持 `observationPack: { mode: auto }`。若完整行摘录无法保留任何原文，则不进行 pack，保留全文。已有 v1 pack 和 handle 仍可读取和恢复。

## 功能

- **Kiokuko Models** — 通过 Web 设置或 `/kiokuko model` 连接并认证，独立于原生 Models 设置。支持 Infron Standard/Flex。[设置与共享凭据](docs/kiokuko-models.md)
- **执行模式** — 选择普通执行或役小角(enno-oduno)，后者提供基于角色的规划和验证。[详情](docs/model-selection.md)
- **项目记忆** — 检索有用的项目知识，供后续工作使用。[概念](docs/concepts.md)
- **深度规划** — 由四个角色开展有边界的只读调查。[使用方法](docs/deep-planning.md)
- **DSH 子代理** — 标准 preset 提供 `subagent` 和 `subagent_fork`；原生子代理不会重复询问 Kiokuko 的执行模式。[配置](docs/dsh-plugin.md#subagents)
- **Continuity** — 默认关闭。设置 `continuity.mode: active`，即可将近期执行证据汇总给模型。[设置](docs/continuity.md)
- **AgenticReplay** — 记录模型与工具活动，并导出为 HTML。[设置与命令](docs/agenticreplay-recording.md)
- **日语输出** — 通过内置 Skill 帮助受支持的模型输出自然的日语。[详情](docs/japanese-output.md)

工具展示默认为 `auto`：根据任务类型和当前阶段决定向模型展示哪些 Kiokuko 工具。原生工具仍然可用；`full` 是需要显式选择的兼容性覆盖选项。请参阅[工具展示](docs/tool-exposure.md)。

## 安装与使用

兼容性通过官方 DSH 当前源码和实际主机 API 验证，不以固定版本名称作为兼容条件。请参阅[验证范围](docs/dsh-plugin.md#compatibility)。

支持 Linux x64/ARM64 和 macOS Apple Silicon，不支持 Intel Mac 和 Windows。

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

启动时会将包括日语输出在内的全部内置 Skill 及其引用文件同步到 `~/.agents/skills/`，创建缺失文件并更新受管理的副本，不覆盖非受管理文件。其他代理需要重新加载 Skill 目录。

以上是完整包的默认行为。[核心与可选模块构建](docs/core-modules.md)仅打包所选资源；核心可独立处理对话、调研、写作和项目记忆，不包含 Enno/Lisp 运行时。

启动时也会更新启动目录中 `AGENTS.md` 的现有 Kiokuko 管理块，保留块外的指令。更新包后请重启 DSH。其他工作目录或旧副本的检查与修复请参阅[设置步骤](docs/dsh-plugin.md#what-setup-updates-and-when)。`kiokuko use` 不是 DSH 的设置命令。

`agenticreplay` 包的版本范围为 `>=0.1.0 <1.0.0`，后续补丁和次版本可在不修改范围的情况下更新。
锁文件会保留已验证的版本，直到明确更新依赖。更新后请重启 DSH。
从 OrcaReplay 升级时，请将显式 `orca` 配置改为 `agenticReplay`；
已保存的记录选择和旧日志会保留，但旧日志不会导入。
[更新详情](docs/dsh-plugin.md#update) · [记录功能迁移](docs/agenticreplay-recording.md#upgrade-from-orcareplay)

DSH 更新后若无法加载 Kiokuko，请参阅[启动恢复步骤](docs/dsh-plugin.md#startup-failure-after-a-dsh-update)，按对应 profile 更新或重新安装。请保留会话日志和 Kiokuko 数据库；重新安装不一定能解决 API 兼容性问题。

[文档](docs/README.md) · [权限](PERMISSIONS.md) · [MIT 许可证](LICENSE)

## 类型化判定（Jev / Laya / Nimble）

可选的[自动模型选择](docs/model-selection.md#automatic-model-selection)会为新的普通任务选择经过验证的 `openai-codex` 模型和推理强度。默认值为 `modelAutoMode.mode: off`；`/kioku-model-auto on | observe | off | status` 仅更改当前会话。`observe` 评估建议，但不更换模型。此功能需要已就绪的 Jev 或 Laya 后端、dsh-codex、原生模型元数据和 token meter。分类失败或不可用时保留当前模型；手动选择优先。

[回答复核](docs/answer-review.md)在完整插件和模块化核心中默认启用。它通过配置的 Jev、Laya 或 Nimble provider 评估已经显示的普通回答，并可能让同一个主模型重新考虑一次。默认配置为：

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

设置 `answerReview.mode: off` 可禁用此功能。它沿用 `typedDecisions` 配置，会增加评估推理（以及最多一轮主模型调用），但不会延迟首次回答。所选 provider 不可用时会跳过复核并保留原回答，不会替换为其他 provider。由于无法检查 worker 内部的截断，Laya v1 的评估结果仅作为未经验证的建议。`/kioku-decisions status` 显示进度与跳过原因，并不证明回答正确。

Jev 是默认选项。在 DSH 命令输入框中即可切换，无需编辑配置或重启 DSH：

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Laya 直接连接由 `start-laya` 启动的现有 worker，无需替换 worker 或配置 fingerprint。Jev 需要 TypeSafe 密钥；Nimble 需要先配置端点和模型。探测成功后，所选项会按项目保存并应用于新的请求。重启后仍会保留，正在处理的请求所绑定的 provider 不变。`use default` 恢复插件配置。

在 DSH 的 `~/.dsh/.credentials.yaml`（设置了 `DSH_HOME` 时为 `$DSH_HOME/.credentials.yaml`）中设置 API 密钥，或使用 `/kioku-typesafe-key YOUR_KEY`。请保留已有条目：

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: YOUR_KEY
```

如果手动创建 YAML 文件，请运行 `chmod 600 ~/.dsh/.credentials.yaml`（设置了 `DSH_HOME` 时使用对应路径）。

在 DSH 命令界面中检查密钥并测试连接：

```text
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe` 会发送合成的 API 测试请求，`status` 不会。`/kioku-typesafe-key clear` 可删除保存的密钥。使用 `/kioku-typesafe-key YOUR_KEY` 时，输入的密钥会显示在界面上。更多信息请参阅[类型化判定](docs/typed-decisions.md)和[显式 Lisp API](docs/typesafe.md)。

Jev 仍为默认选项。Nimble 和本地 [Laya-CoreML](docs/laya-coreml.md)是可选替代方案；Laya 使用现有 v1 `health`/`predict` 协议，直接连接 `~/Library/Caches/laya-coreml/worker.sock`。`/kioku-decisions install-laya` 会复用运行中的 worker，或显示设置说明。

英语及其他语言请使用 `aac6fef/laya-multilingual-coreml`。其 1,024-token 输入容量包括问题、选项和状态；`-ane` 变体仅允许 96 tokens。请参阅[上游模型规格](https://github.com/mizorewww/laya-coreml#available-checkpoints)。完成[初始设置](docs/Laya-CoreML-ja.md)后，使用以下命令。请先停止正在运行的 Laya worker，再使用新模型启动；`LAYA_MODEL` 也会覆盖现有 worker 脚本中的旧默认值。

```bash
mkdir -p ~/.local/share/laya-coreml/multilingual
hf download \
  aac6fef/laya-multilingual-coreml \
  --local-dir ~/.local/share/laya-coreml/multilingual
LAYA_MODEL="$HOME/.local/share/laya-coreml/multilingual" start-laya
```

## 语义记忆复用

[语义记忆复用](docs/memory-reuse.md)在 provider 的合成测试探测成功后，根据当前请求检查已有检索候选。嵌入并非必需；`memoryReuse.mode: off` 可禁用这一步额外筛选。

[记忆应用与验证](docs/memory-application.md)记录采纳或排除等处理结果，以及宿主观察到的回归验证证据。使用 `/kioku-memory-application status` 或 `/kioku-memory-application status --json` 查看当前原生会话的状态。

### 语义压缩

ObservationPack（`observationPack: { mode: auto }`）会将大型、成功的原生工具结果保留供模型调用两次，然后替换为摘录和 `observation_read` 句柄。[语义压缩](docs/semantic-compaction.md)会在 TODO 完成边界进行评估，并在普通、Enno 和 Lisp 模式中，先于原生自动压缩选择性地缩短旧工具结果。默认值为 `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }`，需要已就绪的类型化判定后端及受支持的原生服务。使用 `/kioku-decisions status` 查看启用状态和最近结果。若完整行摘录无法保留任何原文，则保留全文而不进行 pack。现有 v1 pack 和句柄仍可读取和恢复。

Laya 压缩另有独立配置，默认值为 `typedDecisions.laya-coreml.compaction.mode: off`。显式选择 `shadow` 会评估但不改变历史；`auto` 仍处于 `experimental_not_qualified` 状态。此开关保留 ObservationPack 和原生摘要的现有行为。Akinator 仅使用经过验证的 debug/research/writing 范围；可选 Skill 选择最多使用四个信息完整的候选，并由模型最多追加选择一个。请参阅[Laya 设置与评估](docs/semantic-compaction.md#local-laya)。

## 可选代码分析

`kioku.code` 通过 `@askdkc/dsh-lsp-server`，在 Lisp 中读取代码结构和只读 LSP 结果。
请在 `kiokuko-dsh` 所用的同一 profile 中安装或更新。CLI 版请将 `web` 替换为 `dsh-cli`。

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

详见[设置、支持的语言和限制](docs/code-intelligence.md)。


## Lisp

明确的常规实现请求会在第一次模型请求前提议使用 Lisp，包括默认 on-demand native Bash 路径；对话、调研和仅规划请求不强制提议。同一请求的拒绝回答会在 Goal 准备时复用。`/kioku-lisp enable` 开启当前会话。ON 状态下的实现先运行小型相关 `lisp_eval` 试作（`prototype: true`），再用 `lisp_inspect` 查看成功的保存结果，然后才能使用实现工具。ON 显示本身不是验证证据。两次失败后停止自动重试，应修复原因或通过 `/kioku-lisp disable` 选择普通路径。原有权限和 Stop 保持有效。工具显示 `full` 不会开启 Lisp；新请求需要新的试作证据，试作成功不等于任务完成。
