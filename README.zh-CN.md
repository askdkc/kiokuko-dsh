# Kiokuko(記憶庫) DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 添加项目记忆、任务规划和验证支持。
可选的 OrcaReplay 记录功能可用于查看模型和工具活动，并导出 HTML。

## 安装与使用

支持 DSH `0.1.2-rc.1` 和 [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)。
需要 Node.js **24.16.0 以上**和 pnpm。
使用已安装的 `dsh` CLI 安装已发布的 npm 包并启动：

```bash
dsh plugin --profile web add kiokuko-dsh
dsh web
```

从 DSH 源码目录运行时，在每条 `dsh` 命令前加上 `pnpm`。
启动后直接输入任务，无需额外的 Kiokuko setup 操作。
GitHub 和本地安装方式见[插件指南](docs/dsh-plugin.md)。

Orca 依赖会自动安装，记录功能**默认关闭**。
将插件配置中的 `orca.enabled` 设为 `true` 并重新加载即可启用。
使用 `/kioku-orca list`、`/kioku-orca show <run ID>` 和 `/kioku-orca export <run ID>` 查看或导出记录。
详见[记录设置与命令](docs/orca-recording.md)。

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
