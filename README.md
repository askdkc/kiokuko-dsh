
# Kiokuko(記憶庫) DeepSeek Harness Plugin
[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko adds project memory, planning, and verification support to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
OrcaReplay records model/tool activity for inspection and HTML export.


For new coding tasks, choose normal execution or 役小角(enno-oduno). Enno offers model templates and role assignments from configured DSH models. [Model selection and connection limits](docs/model-selection.md).

Use `/deep-planning <problem>` for bounded, read-only investigation and planning with four agent roles. It preserves inputs, supports pause/recovery, and returns partial answers when its estimated budget is exhausted. [Commands, budgets and recovery](docs/deep-planning.md).

DeepSeek, Kimi, GLM, Qwen, HY/Hunyuan, MiMo and MiniMax agents automatically receive the bundled Japanese writing Skill. [Application rules and model identification](docs/japanese-output.md).

## Install and use

Supports DSH [0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1), [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1), and [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2).
Requires Node.js **24.16.0+** and pnpm.
Run these commands from the DSH source directory to install the published npm package and start:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

If you use a globally installed `dsh` CLI, omit `pnpm` from the commands.
Enter your task normally; no Kiokuko setup command is needed.
For GitHub/local installation, see the [plugin guide](docs/dsh-plugin.md).

OrcaReplay is configured automatically; **no manual setup is required**. Every chat records detailed logs without asking.
Recording saves model responses and tool results to `.orca/runs/` in the session workspace. A decision is remembered per session, so `/kioku-orca stop` keeps that chat unrecorded; set `orca.askOnStart: true` to ask at the start of each chat instead.

- `/kioku-orca start`: start recording manually or resume after stopping. Not needed unless this chat was stopped earlier; past activity is not captured.
- `/kioku-orca status`: briefly show the recording state, storage location, and next action. Use `/kioku-orca status --json` for diagnostic details.

Use `/kioku-orca stop` to finalize the log, `list` to find its run ID, `show <run ID>` to inspect it, and `export <run ID>` to create HTML (all under `/kioku-orca`).
To disable recording, set `orca.enabled: false` and reload. See [recording settings and commands](docs/orca-recording.md).

## Update

Finish active tasks and stop DSH before updating. Update the npm-installed plugin:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

At startup, all seven bundled Skills (including Japanese output) and their references are synchronized to `~/.agents/skills/`. Missing files are created and managed copies are updated; unmanaged files are preserved. Other agents must reload their Skill catalog.

To update Orca dependencies after a release such as 0.3.0:

```bash
pnpm dsh plugin --profile web update --depth Infinity '@orcareplay/*'
pnpm dsh plugin --profile web why @orcareplay/core
pnpm dsh web
```

The installed Kiokuko must include the `>=0.2.1` dependency range. It permits
stable 0.3.0 and later releases; it does not automatically update existing installs.
Verify recording and export after updating. See [update details](docs/dsh-plugin.md#update).

If existing chats fail with an unknown `kiokuko/` event, see [history repair](docs/session-history-repair.md).

[Documentation](docs/README.md) · [Permissions](PERMISSIONS.md) · [MIT license](LICENSE)
