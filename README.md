# Kiokuko(記憶庫) DeepSeek Harness Plugin

Memory body delivery defaults to 16,000 Unicode characters; relation metadata has separate bounded coverage. See [memory delivery budgets](docs/memory-delivery.md).
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

Current-upstream compatibility is checked against the resolved official DSH revision, not a fixed release number. Historical release records are separate evidence. See the [verification scope and protected-mode limitation](docs/dsh-plugin.md#compatibility).

Supported platforms: Linux x64/ARM64 and macOS Apple Silicon; Intel Mac and Windows are unsupported.

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
(keep other `config` values), then reload the plugin. A clear native implementation request offers Lisp before the first model request, including the default on-demand Bash path. Conversation, research and plan-only requests do not trigger the offer. A declined choice stays with that request; Goal preparation reuses its human answer.
`/kioku-lisp enable` explicitly enables this session. When Lisp was manually enabled, coding starts with a small relevant `lisp_eval` prototype (`prototype: true`), then `lisp_inspect` of its successful saved result before implementation tools proceed. ON alone is not prototype evidence. Two failed prototypes stop automatic retries; inspect the failure, repair it or explicitly disable Lisp. `/kioku-lisp disable` releases this routine. Native permissions and Stop remain authoritative. Tool exposure `full` does not enable Lisp. A fresh request needs fresh prototype evidence; no task completion is inferred from it.
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

A Lisp default does not have to be chosen again for every task. Set `startupDefaults.lisp` to preselect it; the task card then marks that answer and still lets you change it. See [Startup defaults](#startup-defaults).
Ordinary edits and tests run without further confirmation after that choice. Source/data deletion and existing durable user database mutation require a concrete review. Lisp and ordinary tools coexist. Completion requires current item evidence and a fresh final check through the user’s entry point. See [Goal-driven coding](docs/coding-workflow.md) and [owned execution, receipts and memory reuse](docs/owned-execution.md).
See [setup, APIs, limits and recovery](docs/lisp.md).

<a id="startup-defaults"></a>
## Startup defaults for Lisp and decisions

Every non-trivial task asks once whether to use typed decisions and Lisp, then remembers the answer for that request. Settings → General → **Kiokuko startup defaults** sets the answer that card preselects, so a routine task starts from your usual choice.

| Setting | Values | Effect |
|---|---|---|
| `startupDefaults.decision` | `ask` (default), `on`, `off` | Preselects whether typed decisions are used, and decides it when no question UI is available |
| `startupDefaults.lisp` | `ask` (default), `on`, `off` | Preselects whether Lisp is the execution route |
| `typedDecisions.provider` | `typesafe` (default), `openai`, `nimble`, `laya-coreml` | Backend for new requests |

`ask` leaves the card neutral and preserves the previous behaviour. A default only selects an answer that is already offered: it never grants execution authority, enables a disabled module, or skips the Lisp runtime, approval and Stop checks. The card still appears, still marks the alternative, and the answer picked there wins for that request.

```yaml
- id: kiokuko-dsh
  config:
    startupDefaults:
      decision: on
      lisp: on
    typedDecisions:
      provider: openai
```

The provider default applies wherever no `/kioku-decisions use` selection was saved for this project. An explicit selection stays authoritative and is not overwritten; `use default` returns to the configured value. A provider whose configuration is incomplete, such as Nimble without an endpoint and model, still fails closed rather than substituting another backend.

In a headless host with no question service, `ask` keeps the previous behaviour of following the existing configuration and manual session choice, while `on`/`off` supply that answer explicitly.
## Typed decisions (Jev / Laya / OpenAI / Nimble)

Optional [automatic model selection](docs/model-selection.md#automatic-model-selection) chooses a validated `openai-codex` model and reasoning effort for a new normal task. It defaults to `modelAutoMode.mode: off`; `/kioku-model-auto on | observe | off | status` changes only the current session. `observe` measures a proposal without changing the model. It requires a ready Jev, Laya or OpenAI backend, dsh-codex, native model metadata and a token meter. Failed or unavailable classification keeps the current model; manual model selection takes priority.

[Answer review](docs/answer-review.md) is enabled by default on the full plugin and modular core. It evaluates an already displayed normal answer using the configured Jev, Laya, OpenAI or Nimble provider and may ask the same main model to reconsider once. The defaults are:

```yaml
answerReview:
  mode: auto
  budgetMs: 5000
```

Set `answerReview.mode: off` to disable it. It inherits `typedDecisions`, adds evaluation inference (and at most one main-model turn), and does not delay the first answer. If the selected provider is unavailable, review is skipped and the original answer is preserved; no other provider is substituted. Laya v1 findings are unverified suggestions because worker-side truncation cannot be checked. `/kioku-decisions status` reports progress and skip reasons; it does not certify correctness.


<a id="openai-decisions-setup"></a>
### Set up OpenAI Decisions

Jev remains the default; OpenAI, local Laya and Nimble are alternatives. OpenAI uses the official [Decisions API](https://developers.openai.com/api/docs/guides/decisions), `POST /v1/decisions`, with `gpt-6-luna` as this checkout's default decision model. This is separate from the main chat model: ChatGPT/Codex OAuth login does not supply `OPENAI_API_KEY`, and a TypeSafe/Jev key cannot replace it.

These instructions describe the current source. They do not assert that the published npm `latest` already includes OpenAI support. If `use openai` is unavailable, check the installed build's command support first.

1. Create an API key for your OpenAI API project and add it to the credential store used by the running DSH. With the standard `credentials-local` provider, choose the path as follows:

   | Configuration | Credential file |
   |---|---|
   | Default harness home | `~/.dsh/.credentials.yaml` |
   | Custom `DSH_HOME` | `$DSH_HOME/.credentials.yaml` |
   | Explicit `credentials.path` (the provider's `config.path`) | The configured path, overriding the home default |

   `--profile web` keeps profile packages and patches under `$DSH_HOME/profiles/web`; it does **not** by itself move credentials there. A profile can override `credentials.path`, or its launcher can use another `DSH_HOME`. Use that effective file, not a guessed `profiles/web/.credentials.yaml`.

2. In an existing file, add only `OPENAI_API_KEY` under `refs` and preserve all other `refs` and `records`. This is a minimal **new-file example**, with a nonfunctional placeholder:

   ```yaml
   version: 1
   refs:
     OPENAI_API_KEY: "OPENAI_API_KEY_EXAMPLE_ONLY"
   records: {}
   ```

   Replace the placeholder privately with your key. On macOS/Linux, protect the actual file; for the default path:

   ```sh
   chmod 600 "$HOME/.dsh/.credentials.yaml"
   ```

   Use your configured path instead when it differs. The default `watch: true` reloads valid file edits automatically for subsequent requests; restarting DSH is unnecessary. Do not paste keys into chat, screenshots or Git.

3. In DSH's command input, select OpenAI and inspect the result:

   ```text
   /kioku-decisions use openai
   /kioku-decisions status
   ```

   `use openai` makes a real API probe, which may incur usage charges. Only a successful probe and save persist the choice for this project and new requests; failure or cancellation keeps the prior choice. Existing requests keep their binding. `status` makes no inference call. Optional `/kioku-decisions probe` makes another real probe.

The standard provider resolves **saved file > launch environment > project `.env` > harness-home `.env`**. Environment variables still work when the credentials service is present, unless a saved value overrides them. For an environment-only setup, export the key **before** launching DSH from that shell:

```sh
export OPENAI_API_KEY='OPENAI_API_KEY_EXAMPLE_ONLY'
```

This is a placeholder, not a usable key. An export in another shell after DSH has started does not update its launch snapshot; use the watched file to update an already running instance. Keep credential-bearing `.env` files out of Git.

Other selections remain available:

```text
/kioku-decisions use jev
/kioku-decisions use laya
/kioku-decisions use nimble
/kioku-decisions use default
```

Jev uses `TYPESAFE_API_KEY`; `/kioku-typesafe-key` manages only that key, never the OpenAI key. Laya connects to the existing `start-laya` worker at `~/Library/Caches/laya-coreml/worker.sock` using v1 `health`/`predict`. `install-laya` reuses a worker or shows setup instructions. Nimble requires its configured endpoint and model. `use default` restores the plugin configuration.

See [credential precedence, troubleshooting and configuration](docs/typed-decisions.md#openai-credentials), the [official credential-store reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md), and the [TypeSafe Lisp API](docs/typesafe.md).

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
