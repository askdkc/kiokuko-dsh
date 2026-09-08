# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 添加项目记忆、任务规划和验证支持。
OrcaReplay 可记录模型和工具活动，查看记录并导出 HTML。


新的修改任务可以选择普通执行或役小角(enno-oduno)。役小角支持推荐模板，也可从DSH已配置的模型中为各角色选择模型。[模型选择与连接限制](docs/model-selection.md)。
## 安装与使用

支持 DSH `0.1.2-rc.1`、[0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1) 和 [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2)。
需要 Node.js **24.16.0 以上**和 pnpm。
使用已安装的 `dsh` CLI 安装已发布的 npm 包并启动：

```bash
dsh plugin --profile web add kiokuko-dsh
dsh web
```

从 DSH 源码目录运行时，在每条 `dsh` 命令前加上 `pnpm`。
启动后直接输入任务，无需额外的 Kiokuko setup 操作。
GitHub 和本地安装方式见[插件指南](docs/dsh-plugin.md)。

OrcaReplay 的功能配置会自动安装，**无需手动设置**。聊天开始时，可选择是否记录详细日志。
选择记录后，后续模型回复和工具执行结果将保存到会话工作目录的 `.orca/runs/`。选择按会话保存；跳过或取消时，不记录并继续聊天。

- `/kioku-orca start`：手动开始记录，或在停止后重新开始。如果开始时已选择记录，则无需执行。不会补录过去的活动。
- `/kioku-orca status`：查看功能是否启用、会话的记录选择、记录状态和错误。

用 `/kioku-orca stop` 完成日志记录后，用 `list` 查看 run ID、`show <run ID>` 查看内容、`export <run ID>` 导出 HTML（均在 `/kioku-orca` 后输入）。
要禁用记录，请设置 `orca.enabled: false` 并重新加载。详见[记录设置与命令](docs/orca-recording.md)。

## 更新

先完成正在执行的任务并停止 DSH。更新通过 npm 安装的 Kiokuko：

```bash
dsh plugin --profile web update kiokuko-dsh --latest
```

Orca 发布 0.3.0 等新版本后，更新 Orca 相关依赖：

```bash
dsh plugin --profile web update --depth Infinity '@orcareplay/*'
dsh plugin --profile web why @orcareplay/core
dsh web
```

已安装的 Kiokuko 必须包含 `>=0.2.1` 依赖范围。该范围允许正式版 0.3.0 及后续版本，
但不会自动更新现有安装。更新后请检查记录和 HTML 导出。[更新详情](docs/dsh-plugin.md#update)

[文档](docs/README.md) · [权限](PERMISSIONS.md) · [MIT 许可证](LICENSE)
