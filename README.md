# Kiokuko(記憶庫) DeepSeek Harness Plugin
[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko adds memory, planning, verification, and observability to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Automatic memory review saves or updates useful project candidates after eight completed human turns, even while a chat remains open. It is active by default and uses the session model. Check `/kioku-memory-review status` or exclude a conversation with `/kioku-memory-review exclude session`. [Settings, costs and recovery](docs/auto-memory-review.md).

## Features

- **Execution modes** — Choose normal execution or 役小角(enno-oduno) for role-based planning and verification. [Details](docs/model-selection.md)
- **Project memory** — Retrieve useful project knowledge for later work. [Concepts](docs/concepts.md)
- **Deep planning** — Run bounded, read-only investigation with four roles. [Usage](docs/deep-planning.md)
- **Continuity** — Disabled by default. Set `continuity.mode: active` to summarize recent execution evidence for the model. [Setup](docs/continuity.md)
- **Memory evolution** — Turn completed work into reusable episode and lesson candidates. [Settings](docs/memory-evolution.md)
- **OrcaReplay** — Record model/tool activity and export it as HTML. [Settings and commands](docs/orca-recording.md)
- **Japanese output** — Give supported models a bundled Skill for natural Japanese. [Details](docs/japanese-output.md)

## Install and use

Supports **DSH 0.1.6-alpha.1** ([verification scope](docs/dsh-plugin.md#compatibility)).

Requires Node.js **24.16.0+** and pnpm.
Run these commands from the DSH source directory to install the published npm package and start:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

If you use a globally installed `dsh` CLI, omit `pnpm` from the commands.
Enter your task normally; no Kiokuko setup command is needed.
For GitHub/local installation, see the [plugin guide](docs/dsh-plugin.md).

## Update

Finish active tasks and stop DSH before updating. Update the npm-installed plugin:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

Kiokuko releases frequently, and pnpm 11 applies a 24-hour
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
by default. If `update --latest` keeps the previous version, add Kiokuko to
`minimumReleaseAgeExclude` in `~/.dsh/profiles/web/pnpm-workspace.yaml` (not
`pnpm-lock.yaml`), then run the update command again:

```yaml
minimumReleaseAgeExclude:
  - kiokuko-dsh
```

At startup, all nine bundled Skills (including Japanese output) and their references are synchronized to `~/.agents/skills/`. Missing files are created and managed copies are updated; unmanaged files are preserved. Other agents must reload their Skill catalog.

These are the full-package defaults. The [configured core and optional modules](docs/core-modules.md) build ships only selected resources; core alone provides conversation, research, writing and project memory without Enno/Lisp runtimes.

Startup also refreshes an existing Kiokuko managed block in the startup directory’s `AGENTS.md`, preserving your other instructions. Restart DSH after updating the package. See [setup and verification](docs/dsh-plugin.md#what-setup-updates-and-when) for another workspace or stale copies; `kiokuko use` is not the DSH setup command.

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

If Kiokuko fails to load after a DSH update, see [startup recovery](docs/dsh-plugin.md#startup-failure-after-a-dsh-update) for profile-specific update and reinstall commands. Keep session logs and the Kiokuko database; reinstallation cannot fix every API incompatibility.

[Documentation](docs/README.md) · [Permissions](PERMISSIONS.md) · [MIT license](LICENSE)
## Optional Common Lisp tools

Install SBCL first:

- macOS: `brew install sbcl`
- Debian / Ubuntu: `sudo apt install sbcl`
- Arch Linux: `sudo pacman -S sbcl`

Add this to the `kiokuko-dsh` row in `~/.dsh/profiles/web/cordis.patch.yml`
(keep other `config` values), then reload the plugin. The first implementation or
debugging request asks whether to use Lisp; the session retains your choice.
You can also enable it with `/kioku-lisp enable`.
Check the loaded configuration with `dsh --profile web --dump-config`.

```yaml
- id: kiokuko-dsh
  config:
    lisp:
      enabled: true
      sbclPath: sbcl
```

Linux also requires Bubblewrap.
Choosing Lisp starts normal execution with the Lisp tools. Choose not to use Lisp
if you want Enno. Free text is passed to the AI as a discussion or correction.
Deletion and replacement of existing files require human confirmation.
See [setup, APIs, limits and recovery](docs/lisp.md).

## TypeSafe (Jev)

Kiokuko can use Jev for automatic typed decisions. Add this to the existing `kiokuko-dsh` row in `~/.dsh/profiles/web/cordis.patch.yml`, keeping its other `config` values:

```yaml
- id: kiokuko-dsh
  config:
    typedDecisions:
      mode: auto
      provider: typesafe
      typesafe:
        model: jev-latest
```

Set the API key in DSH's `~/.dsh/.credentials.yaml` (`$DSH_HOME/.credentials.yaml` if set), or use `/kioku-typesafe-key YOUR_KEY`. Keep any existing entries:

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: YOUR_KEY
```

If creating the YAML file yourself, run `chmod 600 ~/.dsh/.credentials.yaml` (use `$DSH_HOME` if set).

Reload DSH after changing the plugin configuration. In the DSH command UI, check the key and test the connection:

```text
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe` sends a synthetic API request; `status` does not. `/kioku-typesafe-key clear` removes the stored key. Key input is visible when using `/kioku-typesafe-key YOUR_KEY`. See [typed decisions](docs/typed-decisions.md) and the [explicit Lisp API](docs/typesafe.md) for more.

Jev remains the default. Nimble and local [Laya-CoreML](docs/laya-coreml.md) are optional alternatives; Laya connects directly to `~/Library/Caches/laya-coreml/worker.sock` and requires the documented strict worker update.

## Semantic memory reuse

[Semantic memory reuse](docs/memory-reuse.md) checks existing retrieval candidates
against the current request after a synthetic provider probe succeeds. Embeddings
are optional; `memoryReuse.mode: off` disables this additional selection.

[Memory application and verification](docs/memory-application.md) records dispositions and host-observed regression evidence. Check the current native session with `/kioku-memory-application status` or `/kioku-memory-application status --json`.

### Semantic compaction

ObservationPack (`observationPack: { mode: auto }`) preserves large successful native tool results for two model calls, then replaces them with excerpts and an `observation_read` handle. [Semantic compaction](docs/semantic-compaction.md) evaluates TODO completion boundaries and selectively shortens old tool results before native automatic compaction in normal, Enno and Lisp modes. It defaults to `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }` and requires a ready typed-decision backend and supported native services. Inspect activation and the last outcome with `/kioku-decisions status`.
