# Kiokuko(記憶庫) DeepSeek Harness Plugin
[日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko adds memory, planning, verification, and observability to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Memory is optional. After a task ends, Kiokuko asks whether to organize recorded experience, shows an ephemeral preview, and saves only the exact revision the user approves. Automatic memory writers are retired. [Review, recall and forgetting](docs/replay-memory-review.md).

Inspect sources and corrections with `/kioku-memory explain ENTRY_ID`; explicitly forget a memory with `/kioku-memory forget ENTRY_ID --revision N`. [Evidence, explanations and forgetting](docs/memory-evidence.md).

## Features

- **Kiokuko Models** — Connect and authenticate from Web Settings or `/kiokuko model`, independently of native Models settings. Includes Infron Standard/Flex. [Setup and shared credentials](docs/kiokuko-models.md)
- **Execution modes** — Choose normal execution or 役小角(enno-oduno) for role-based planning and verification. [Details](docs/model-selection.md)
- **Project memory** — Retrieve useful project knowledge for later work. [Concepts](docs/concepts.md)
- **Deep planning** — Run bounded, read-only investigation with four roles. [Usage](docs/deep-planning.md)
- **DSH subagents** — The standard preset provides `subagent` and `subagent_fork`; native children do not repeat Kiokuko's execution-mode choice. [Configuration](docs/dsh-plugin.md#subagents)
- **Continuity** — Disabled by default. Set `continuity.mode: active` to summarize recent execution evidence for the model. [Setup](docs/continuity.md)


- **AgenticReplay** — Record model/tool activity and export it as HTML. [Settings and commands](docs/agenticreplay-recording.md)
- **Japanese output** — Give supported models a bundled Skill for natural Japanese. [Details](docs/japanese-output.md)

Tool exposure defaults to `auto`: task type and current phase determine the Kiokuko model tools shown. Native tools stay available; `full` is an explicit compatibility override. See [tool exposure](docs/tool-exposure.md).

## Install and use

Runtime compatibility target: **DSH 0.2.1-alpha.2**, with the `web` and `dsh-cli` profiles. See the [verification scope](docs/dsh-plugin.md#compatibility).

Requires Node.js **24.16.0+** and pnpm.
From the DSH source directory, install and start the Web profile:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh web
```

Install and start the CLI profile:

```bash
pnpm dsh plugin --profile dsh-cli add @askdkc/dsh-cli
pnpm dsh plugin --profile dsh-cli add kiokuko-dsh
pnpm dsh --profile dsh-cli
```

If you use a globally installed `dsh` CLI, omit `pnpm` from the commands.
Enter your task normally; no Kiokuko setup command is needed.
For GitHub/local installation, see the [plugin guide](docs/dsh-plugin.md).

Recordings keep `capture.content: redacted` by default. To minimize body storage, select `agenticReplay.capture.content: metadata`; raw capture is unavailable. Known credential assignments, quoted values, authentication headers and URL credentials are removed while ordinary text remains. This does not detect every secret or rewrite earlier traces and exports; managing earlier files is a separate user action.

## Update

Stop DSH, then update and restart the Web profile:

```bash
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh web
```

Stop DSH, then update and restart the CLI profile:

```bash
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
pnpm dsh --profile dsh-cli
```

To update a release published within the last 24 hours, disable pnpm 11's default
[`minimumReleaseAge`](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)
check for Kiokuko and its dependencies. Confirm that the second command prints `0`,
then update:

```bash
pnpm config set --location=global --json minimumReleaseAge 0
pnpm config get minimumReleaseAge
pnpm dsh plugin --profile web update kiokuko-dsh --latest
pnpm dsh plugin --profile dsh-cli update kiokuko-dsh --latest
```

This setting persists globally and disables the release-age check for future pnpm
installs and updates as well. Restart DSH after the update succeeds.

At startup, all seventeen bundled Skills (including Japanese output) and their references are synchronized to `~/.agents/skills/`. Missing files are created and managed copies are updated; unmanaged files are preserved. Other agents must reload their Skill catalog.

These are the full-package defaults. The [configured core and optional modules](docs/core-modules.md) build ships only selected resources; core alone provides conversation, research, writing and project memory without Enno/Lisp runtimes.

Startup also refreshes an existing Kiokuko managed block in the startup directory’s `AGENTS.md`, preserving your other instructions. Restart DSH after updating the package. See [setup and verification](docs/dsh-plugin.md#what-setup-updates-and-when) for another workspace or stale copies; `kiokuko use` is not the DSH setup command.

The `agenticreplay` distribution uses `>=0.1.0 <1.0.0`, so future patch and minor releases
can be installed by an explicit dependency update without changing the range.
Lockfiles retain the tested versions until updated. Restart DSH afterward.
When upgrading from OrcaReplay, rename explicit `orca` settings to `agenticReplay`;
saved session choices survive and legacy traces are retained but not imported.
[Update details](docs/dsh-plugin.md#update) · [Recording upgrade](docs/agenticreplay-recording.md#upgrade-from-orcareplay)

If existing chats fail with an unknown `kiokuko/` event, see [history repair](docs/session-history-repair.md).

If Kiokuko fails to load after a DSH update, see [startup recovery](docs/dsh-plugin.md#startup-failure-after-a-dsh-update) for profile-specific update and reinstall commands. Keep session logs and the Kiokuko database; reinstallation cannot fix every API incompatibility.

[Documentation](docs/README.md) · [Permissions](PERMISSIONS.md) · [MIT license](LICENSE)
## Optional Common Lisp tools

Install SBCL first:

- macOS: `brew install sbcl`
- Debian / Ubuntu: `sudo apt install sbcl`
- Arch Linux: `sudo pacman -S sbcl`

Add this to the `kiokuko-dsh` row in the selected profile’s
`~/.dsh/profiles/<profile>/cordis.patch.yml` (`web` or `dsh-cli`)
(keep other `config` values), then reload the plugin. Each implementation task
shows its Goal, items and observable checks before asking whether to use Lisp.
The choice belongs to that task and scope; a new task asks again.
You can also enable it with `/kioku-lisp enable`.
Check it with `dsh --profile <profile> --dump-config`, using the same profile name.

```yaml
- id: kiokuko-dsh
  config:
    lisp:
      enabled: true
      sbclPath: sbcl
```

The default development mode does not require Bubblewrap. The explicit protected compatibility mode does on Linux.
Choose “使う” to use Lisp, “使わない” to use ordinary tools, or “取消・作業を保持” to cancel while preserving prepared work. Closing the question leaves implementation pending. Lisp choice and normal/Enno selection are separate. A failed Lisp startup remains a recoverable blocker until the selected route works or you explicitly change it.
Ordinary edits and tests run without further confirmation after that choice. Source/data deletion and existing durable user database mutation require a concrete review. Lisp and ordinary tools coexist. Completion requires current item evidence and a fresh final check through the user’s entry point. See [Goal-driven coding](docs/coding-workflow.md) and [owned execution, receipts and memory reuse](docs/owned-execution.md).
See [setup, APIs, limits and recovery](docs/lisp.md).

## Typed decisions (Jev / Laya / Nimble)

Optional [automatic model selection](docs/model-selection.md#automatic-model-selection) chooses a validated `openai-codex` model and reasoning effort for a new normal task. It defaults to `modelAutoMode.mode: off`; `/kioku-model-auto on | observe | off | status` changes only the current session. `observe` measures a proposal without changing the model. It requires a ready Jev or Laya backend, dsh-codex, native model metadata and a token meter. Failed or unavailable classification keeps the current model; manual model selection takes priority.

[Answer review](docs/answer-review.md) is enabled by default on the full plugin and modular core. It evaluates an already displayed normal answer using the configured Jev, Laya or Nimble provider and may ask the same main model to reconsider once. The defaults are:

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

Set `answerReview.mode: off` to disable it. It inherits `typedDecisions`, adds evaluation inference (and at most one main-model turn), and does not delay the first answer. If the selected provider is unavailable, review is skipped and the original answer is preserved; no other provider is substituted. Laya v1 findings are unverified suggestions because worker-side truncation cannot be checked. `/kioku-decisions status` reports progress and skip reasons; it does not certify correctness.


Jev is the default. Switch in DSH's command input without editing configuration or restarting DSH:

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Laya connects directly to the existing worker started by `start-laya`; no worker replacement or fingerprint setup is needed. Jev needs a TypeSafe key; Nimble needs an endpoint and model configured first. A successful probe saves the selection for this project and applies it to new requests. It survives restarts and preserves in-flight request bindings. `use default` restores the plugin configuration.

Set the API key in DSH's `~/.dsh/.credentials.yaml` (`$DSH_HOME/.credentials.yaml` if set), or use `/kioku-typesafe-key YOUR_KEY`. Keep any existing entries:

```yaml
version: 1
refs:
  TYPESAFE_API_KEY: YOUR_KEY
```

If creating the YAML file yourself, run `chmod 600 ~/.dsh/.credentials.yaml` (use `$DSH_HOME` if set).

In the DSH command UI, check the key and test the connection:

```text
/kioku-typesafe-key status
/kioku-decisions probe
/kioku-decisions status
```

`probe` sends a synthetic API request; `status` does not. `/kioku-typesafe-key clear` removes the stored key. Key input is visible when using `/kioku-typesafe-key YOUR_KEY`. See [typed decisions](docs/typed-decisions.md) and the [explicit Lisp API](docs/typesafe.md) for more.

Jev remains the default. Nimble and local [Laya-CoreML](docs/laya-coreml.md) are optional alternatives; Laya connects directly to `~/Library/Caches/laya-coreml/worker.sock` using the existing v1 `health`/`predict` protocol. `/kioku-decisions install-laya` reuses a running worker or shows setup instructions.

Use `aac6fef/laya-multilingual-coreml` for English and other languages. Its 1,024-token input capacity includes the question, options and state; the `-ane` variant allows only 96 tokens. See the [upstream model specifications](https://github.com/mizorewww/laya-coreml#available-checkpoints). After the [initial setup](docs/Laya-CoreML-ja.md), use the following commands. Stop any running Laya worker before starting it with the new model; `LAYA_MODEL` also overrides the old default in an existing worker script.

```bash
mkdir -p ~/.local/share/laya-coreml/multilingual
hf download \
  aac6fef/laya-multilingual-coreml \
  --local-dir ~/.local/share/laya-coreml/multilingual
LAYA_MODEL="$HOME/.local/share/laya-coreml/multilingual" start-laya
```

## Semantic memory reuse

[Semantic memory reuse](docs/memory-reuse.md) checks existing retrieval candidates
against the current request after a synthetic provider probe succeeds. Embeddings
are optional; `memoryReuse.mode: off` disables this additional selection.

[Memory application and verification](docs/memory-application.md) records dispositions and host-observed regression evidence. Check the current native session with `/kioku-memory-application status` or `/kioku-memory-application status --json`.

### Semantic compaction

ObservationPack (`observationPack: { mode: auto }`) preserves large successful native tool results for two model calls, then replaces them with excerpts and an `observation_read` handle. [Semantic compaction](docs/semantic-compaction.md) evaluates TODO completion boundaries and selectively shortens old tool results before native automatic compaction in normal, Enno and Lisp modes. It defaults to `semanticCompaction: { mode: auto, preemptive: true, budgetMs: 5000 }` and requires a ready typed-decision backend and supported native services. Inspect activation and the last outcome with `/kioku-decisions status`. Results whose complete-line excerpt would contain no source text are retained in full instead of being packed. Existing v1 packs and handles remain readable and restorable.

Laya compaction separately defaults to `typedDecisions.laya-coreml.compaction.mode: off`. Explicit `shadow` evaluates without changing history; `auto` remains `experimental_not_qualified`. This switch preserves ObservationPack and native summaries. Akinator uses only the verified debug/research/writing range, and optional Skill selection uses up to four complete candidates with at most one model-selected addition. See [Laya settings and evaluation](docs/semantic-compaction.md#local-laya).

## Optional code intelligence

`kioku.code` uses `@askdkc/dsh-lsp-server` to read code structure and LSP results from Lisp.
Install or update it in the same profile as `kiokuko-dsh`. For CLI, replace `web` with `dsh-cli`.

```sh
pnpm dsh plugin --profile web add @askdkc/dsh-lsp-server@latest
pnpm dsh plugin --profile web update @askdkc/dsh-lsp-server --latest
```

See [setup, supported languages and limits](docs/code-intelligence.md).
