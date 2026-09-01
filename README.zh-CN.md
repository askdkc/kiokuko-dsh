# Kiokuko DeepSeek Harness Plugin

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

`@askdkc/kiokuko` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 out-of-tree Cordis Plugin。
它不 fork 或 patch Harness 源码。此仓库不是 OpenCode Plugin，也不是通用 Kiokuko MCP 安装指南。

## 要求与安装

需要 Node.js 24.16.0 或更高版本，DeepSeek Harness 兼容目标为 `0.1.2-alpha.3`。

```bash
pnpm dsh plugin --profile web add @askdkc/kiokuko
pnpm dsh --profile web --dump-config
```

删除 Plugin：

```bash
pnpm dsh plugin --profile web remove @askdkc/kiokuko
```

安装后的 dsh CLI 使用相同参数但省略 `pnpm`。Plugin 只添加 `kiokuko-dsh` bundle row，不修改其他 Plugin、仓库文件、MCP 配置或 `AGENTS.md`。

## 强制边界

- Akinator intake 未解决时，不执行模型和非 Kiokuko 工具。
- 14 个 Kiokuko operation 中，只有 7 个 model-facing operation 暴露给模型。
- tool body 执行前检查 phase、run、revision、route、lease 和 idempotency。
- SessionEvent 以有序、幂等方式桥接到 Kiokuko ledger；验证失败会强制 corrective step。

OpenCode、Codex、Claude Code 和 Hermes Agent 不属于此仓库的 Plugin surface；它们使用 Kiokuko 本体的 MCP/client setup。详见[DeepSeek Harness Plugin 指南](docs/dsh-plugin.md)。

## 安全性与限制

Kiokuko 不保存完整对话，并拒绝看起来像密码、API key、token 或私钥的内容。记忆只是参考信息，应以当前代码和运行结果为准。

MCP 是否调用由客户端和模型决定，**不保证每一轮都会调用 Kiokuko**。详细安全边界请看[英文 Security and trust](docs/security-and-trust.md)。

## 详细文档

请从[英文文档目录](docs/README.md)开始；其中链接到 Getting started、Concepts、Enno-Oduno、Semantic retrieval、Security and trust，
以及实现者用的 architecture、database、execution-ledger 和 client-compatibility 文档。
