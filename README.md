# Kiokuko(記憶庫) DeepSeek Harness Plugin

[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko adds project memory, planning, and verification support to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
OrcaReplay records model/tool activity for inspection and HTML export.


For new coding tasks, choose normal execution or 役小角(enno-oduno). Enno offers model templates and role assignments from configured DSH models. [Model selection and connection limits](docs/model-selection.md).
## Install and use

Supports DSH `0.1.2-rc.1`, [0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1), and [v0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2).
Requires Node.js **24.16.0+** and pnpm.
With an installed `dsh` CLI, install the published npm package and start:

```bash
dsh plugin --profile web add kiokuko-dsh
dsh web
```

From a DSH checkout, prefix each `dsh` command with `pnpm`.
Enter your task normally; no Kiokuko setup command is needed.
For GitHub/local installation, see the [plugin guide](docs/dsh-plugin.md).

OrcaReplay is configured automatically; **no manual setup is required**. At the start of a chat, choose whether to record detailed logs.
Choosing to record saves subsequent model responses and tool results to `.orca/runs/` in the session workspace. The choice is remembered per session; skipped or cancelled questions continue without recording.

- `/kioku-orca start`: start recording manually or resume after stopping. Not needed if you chose to record at the start; past activity is not captured.
- `/kioku-orca status`: check feature availability, the session recording choice, recording state, and errors.

Use `/kioku-orca stop` to finalize the log, `list` to find its run ID, `show <run ID>` to inspect it, and `export <run ID>` to create HTML (all under `/kioku-orca`).
To disable recording, set `orca.enabled: false` and reload. See [recording settings and commands](docs/orca-recording.md).

## Update

Finish active tasks and stop DSH before updating. Update the npm-installed plugin:

```bash
dsh plugin --profile web update kiokuko-dsh --latest
```

To update Orca dependencies after a release such as 0.3.0:

```bash
dsh plugin --profile web update --depth Infinity '@orcareplay/*'
dsh plugin --profile web why @orcareplay/core
dsh web
```

The installed Kiokuko must include the `>=0.2.1` dependency range. It permits
stable 0.3.0 and later releases; it does not automatically update existing installs.
Verify recording and export after updating. See [update details](docs/dsh-plugin.md#update).

[Documentation](docs/README.md) · [Permissions](PERMISSIONS.md) · [MIT license](LICENSE)
