# Client compatibility policy

Status: global MCP integration for Codex, OpenCode, Claude Code, and profile-scoped Hermes Agent. Enno-Oduno continuation adapters are bounded and available for Codex, OpenCode, and Claude Code; Hermes has no Enno continuation adapter.

| Client | Global MCP registration | Global instructions | Managed standard skills | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | `~/.agents/skills/{memory-reasoning,kiokuko-soul,kiokuko-enno-oduno,kiokuko-single-purpose-functions,kiokuko-ui-design-soul}` | bounded Stop hook when Enno-Oduno is enabled |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | global config `skills/{memory-reasoning,kiokuko-soul,kiokuko-enno-oduno,kiokuko-single-purpose-functions,kiokuko-ui-design-soul}` | bounded `session.idle` plugin when Enno-Oduno is enabled |
| Claude Code | managed `mcpServers.kiokuko` property in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | managed block in global `CLAUDE.md` | Claude config `skills/{memory-reasoning,kiokuko-soul,kiokuko-enno-oduno,kiokuko-single-purpose-functions,kiokuko-ui-design-soul}` | bounded Stop hook when Enno-Oduno is enabled |
| Hermes Agent | managed `mcp_servers.kiokuko` in the effective profile `config.yaml` | none | effective profile `skills/{memory-reasoning,kiokuko-soul,kiokuko-enno-oduno,kiokuko-single-purpose-functions,kiokuko-ui-design-soul}` | none |
| DeepSeek Harness | profile-scoped plugin manager entry for `kiokuko-dsh/dsh` | host-managed | package-bundled six standard Skills | bounded Cordis `agent/turn-stopping` and lifecycle seams |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | not installed | none |

OpenCode global configuration follows XDG paths on every platform:
`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when unset. On Windows,
`~` resolves from `%USERPROFILE%`, falling back to `%HOME%`; `%APPDATA%` and
`%LOCALAPPDATA%` are not OpenCode global configuration roots.

Codex's current official documentation supports stdio MCP servers and global
configuration. OpenCode's current official documentation supports local MCP
commands and global rules. Claude Code supports user-scoped stdio MCP servers,
global `CLAUDE.md`, and auto-discovered skills. `kiokuko setup` uses the MCP and
instruction surfaces and installs the bundled `memory-reasoning`, `kiokuko-soul`, `kiokuko-enno-oduno`,
`kiokuko-single-purpose-functions`, and `kiokuko-ui-design-soul` skills in the selected supported clients by
default. The skills are copied from a fixed package manifest and never downloaded
during setup. `--no-standard-skills`
skips placement without deleting an existing copy.

Hermes Agent v0.20.4 uses a profile-scoped native stdio MCP client. Kiokuko writes
only the effective profile's `config.yaml` entry:

```yaml
mcp_servers:
  # Managed by `kiokuko setup`.
  kiokuko:
    command: kiokuko
    args: [mcp]
    env:
      KIOKUKO_SKILL_DISCOVERY: official
```

It does not create a global instruction file, Hermes plugin, or Hermes hook.
Hermes's built-in memory and Kiokuko's bundled skills remain separate capabilities.
Use `kiokuko setup --clients hermes`, then restart Hermes Agent or start a new
session; `/reload-mcp` only reloads MCP registration. Smoke-test with
`hermes mcp test kiokuko`.

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex skills](https://developers.openai.com/codex/skills)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode skills](https://opencode.ai/docs/skills)
- [Claude Code MCP servers](https://code.claude.com/docs/en/mcp)
- [Claude Code memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md)

## Guarantees and non-guarantees

Setup guarantees safe, repeatable configuration merging and makes the Kiokuko MCP
tools available in each configured client scope after that client reloads its
configuration and makes the bundled standard skills discoverable after a client
restart or new session. Global instructions request `task_prepare` before non-trivial work, grounded
`task_answer` calls when intake fields are missing, and checkpointing after
substantial verified work.

No supported client guarantees that a model will call an available tool for every
prompt. Therefore “automatic” means no per-repository install and no manual CLI
lifecycle after one-time setup; it does not mean Kiokuko intercepts every prompt
or response. For Hermes specifically, automatic/model use is best effort from
MCP tool descriptions.

The `kiokuko-soul` standard skill is the canonical first-read router. Managed
instruction surfaces require it before another bundled Kiokuko skill. Every
`task_prepare` call requires `soulRead: true` as an explicit claim that the
complete local Skill was read for that logical request, and the capability gate
requires an exact local `kiokuko-soul` descriptor for every task. Omission or
false attestation is invalid; missing or unknown capability availability returns
`required_capability_unavailable` even while intake needs an answer. A
namespaced, fetched, or reference-only skill does not satisfy the required
master SOUL. The boolean attestation is enforceable protocol evidence, not
remote proof that a model understood or followed the Skill.

The `memory-reasoning` standard skill is installed by default, but filesystem
placement is not proof that the current model loaded or followed it. For ready
build/debug tasks, clients advertise the exact local capability only when it is
actually available. If it is missing or availability is unknown, Kiokuko sets
`memoryPolicy.contextWithheld=true`, reports `memory_reasoning_missing` or
`memory_reasoning_unknown` in `memoryPolicy.withheldReason`, returns no actionable
ordinary memory, and leaves `nextAction=proceed`. An unmanaged same-name file
causes setup to fail closed; move or remove that file manually before rerunning
setup if Kiokuko should own the destination.

The UI standard skill is intended for explicit UI, UX, frontend, screen, SwiftUI,
accessibility, and equivalent Japanese-language tasks. `task_prepare` treats it
as a first-party recommendation only for such concrete terms; generic `design`,
backend-only work, and image-only generation do not trigger it.

The UI and function standard Skills use progressive disclosure. Their short
`SKILL.md` files are mandatory indexes, while versioned expert fragments are
selected for the concrete component, function, design decision, or WorkUnit.
Normal execution reads one to three fragments rather than every reference.

The single-purpose-functions standard skill applies to writing, modifying,
reviewing, debugging, and refactoring code across languages and repositories.
Its examples use typed TypeScript for concreteness, but the contracts explicitly
adapt to the target project's language, error model, persistence layer, and test
framework. `task_prepare` treats it as a first-party recommendation for concrete
coding terms in English or Japanese. Explicit no-code, documentation-only, and
image-only work do not trigger it. Kiokuko does not claim that availability alone
forces model use.

The Enno-Oduno standard skill is the role-level controller contract. Every
Enno-Oduno directive and WorkUnit retains `kiokuko-soul` first. Enno-Oduno
directives then require `kiokuko-enno-oduno` during intake, Oduno ideal
derivation, confirmation, final review, and Oduno meditation. A ready intake
enters `oduno_ideal`: `enno_ideal_submit` derives the optimal target from the
structured `task_prepare` handoff plus exactly one contribution per
Akinator-discovered Skill before Zenki can plan. After accepted final
verification, `oduno_meditation` inspects changed and approved paths for
evidence-backed obsolete test or function candidates without deleting them;
`enno_meditation_submit` persists that reflection and completes the run. The
controller skill itself is not inserted into Zenki's WorkUnit
Skill snapshot; Zenki continues to require the single-purpose-functions skill
for every code-changing plan. Every code-changing WorkUnit persists one to
three registered `expertRefs`; UI WorkUnits include at least one `code.*` and
one `ui.*` expert. Unknown, duplicate, missing, or oversized expert mixtures
are rejected before Skill discovery or repository mutation.

A `needs_confirmation` response carries
`ennoOduno.directive.userFacingConfirmation`, a deterministic display
projection of the decided contract. It presents scope paths, exclusions,
completion criteria, work items with display-number dependencies, skills with
their reference-only status, expertise with selection reasons, focused and
final checks (executable, arguments, directory, and timeout kept separate, never
joined into a shell command), and the attempt limit, each labeled with its
provenance basis (`user`, `repository`, or `proposal` for inferred fields). The
directive also carries a fixed confirmation report schema and objective, so the
client model presents every item in the user's language, translating headings
only, without raw directive JSON, internal field names, WorkUnit IDs, expert
IDs, or verifier IDs, and then waits for an explicit approve, revise, or cancel
through `enno_answer` at the confirmed contract revision. Projection content
that resembles a secret or exceeds the 64 KiB display bound rejects the plan
submit instead of being redacted or truncated. `needs_confirmation` stays
outside the Codex Stop hook, Claude Code Stop hook, and OpenCode
`session.idle` continuation candidates, so no client auto-continues through a
user confirmation.

Final Review is two-phase. `enno_verify_prepare` runs the approved final
verifiers outside database transactions with shell disabled and a
repository-relative cwd, stores evidence bound to contract/mutation revision,
verifier specification, and complete repository state, and only then permits
the final-review advisory fanout. `enno_finish` rechecks that state, decides
accept/replan/block from the complete stored context, never spawns a subprocess,
and rejects unready evidence as a conflict. Passing tests alone do not accept a
run; Enno-Oduno must accept the current contract.

All supported clients consume the same bounded `ENNO_INPUT_INVALID` validation
envelope and the same WorkUnit-local route contract. New verifier cwd values are
repository-relative. Continuation adapters transport opaque resume tokens and
route epochs; Goki transports the returned execution lease. Old tokens become
invalid after rerouting, and an active lease prevents another client from
rerouting or reporting the same WorkUnit.

If the environment information needed to start a plan is absent or no longer
matches the task-preparation binding, the MCP result instead contains a
non-mutating `userFacingRecovery` projection. Clients translate and present
only its what-happened, work-state, resolution, and choices. Every choice is
shown as its translated label and recommendation, followed by its translated
`whenToChoose` intent and exact `whatHappens` result. The machine `action`,
internal tool and field names, catalog, hashes, run identity, revisions,
presentation version, reason codes, and raw JSON remain hidden. The client must
not retry, cancel, or create a replacement automatically.

For missing information, continuing attaches the complete catalog retained by
the host and reuses the same attempt; reviewing asks the user for changes and
starts no implementation before the answer; cancelling ends the current attempt
without a replacement. For changed environment information, restarting first
cancels the active planning attempt and then opens a new task with the current
environment and agreed plan. Review-before-restart asks for changes first, then
cancels and replaces the active attempt only after the answer. If a legacy
attempt already ended because the catalog was provably lost during plan
submission, both restart choices leave that terminal attempt unchanged and open
a replacement only after the user chooses and, for review, answers. Cancelling
an already-ended attempt creates nothing.

For new Codex, OpenCode, and Claude Code setup, Enno-Oduno continuation is
enabled by default; existing managed installations remain unchanged until
`--enno-oduno on` is selected. Setup installs only the bounded native adapter
for each of those clients: a Codex or Claude Code Stop hook, or an OpenCode
`session.idle` plugin. Hermes receives no Enno continuation adapter. During an
adapter continuation, `client_session_id` is routing metadata rather than
authorization ownership. A valid short-lived resume token wins; otherwise the current
local Codex, Claude Code, or OpenCode session may atomically reroute the single
unambiguous active run in the canonical repository, including across client
kinds. Rerouting increments the route epoch and invalidates old tokens; an
active WorkUnit execution lease blocks it. Multiple active candidates remain
unchanged. A per-session continuation limit stops only that session and leaves
the run and ledger active for another local project client. Hermes has no
automatic hook but may continue the same run through MCP with its exact run
identity. The public `clientBinding` field reports this current route; its
`bound` state does not grant ownership.
upgrade, `--enno-oduno off` removes only the exact Enno-owned adapter, while
setup also removes only the byte-exact retired OpenCode guard and the one exact
retired Claude prompt handler. A modified, duplicate, relocated, or partial
legacy identity is `CONFLICT` and requires manual review; unrelated client
settings are preserved.

`task_prepare` can accept an ephemeral catalog of skill and MCP-tool names from
the calling client. Kiokuko matches Akinator policy recommendations and task
terms against that catalog, but cannot enumerate another MCP server or a
client's private skill registry by itself. A result therefore distinguishes
`available`, `missing`, and `unknown`; it never treats a fetched `SKILL.md` as
installed or executable. External skill discovery is controlled independently
by `KIOKUKO_SKILL_DISCOVERY=off|official|community` and defaults to `official`.
When enabled, Kiokuko compares the project fingerprint with relevant client
skills rather than checking whether the catalog is globally empty. An omitted
catalog is treated as unknown availability; official reference-only discovery
may still proceed, but fetched skills are never treated as installed or
executable. Akinator discovery and `kiokuko skills find` share the same
provider-backed `findSkills` operation. There is no legacy fixed-source sync or
guessed-source fallback; bounded exact verification of a reviewed,
catalog-pinned source remains.

`task_prepare` also requires a bounded opaque `requestId`. Clients create a new
ID for every logical user request, including a later request with identical task
text, and reuse an ID only for an exact transport retry. Reusing an ID with
changed bound intake input is `CONFLICT`; `client.sessionId` is not a turn or
request identity. The raw request ID is not stored.
The normalized context budget is part of the bound request and every
`task_answer` must repeat it; a changed budget conflicts before intake mutation.

The legacy ungated `guide context` path was removed. Task-aware context must use
`task_prepare` / `task_answer` or the generic Agent bridge so the same
`kiokuko-soul` hard gate applies. External Skill discovery belongs to
`task_prepare` or the explicit `skills find` / `skills import` commands.

Every `task_answer` request must include the exact `run.runId`, capability
catalog, and context budget supplied to `task_prepare`; clients must not fall
back to session-only run lookup or replace those bindings between answers. Inspect
`nextAction` and `memoryPolicy` after every `task_prepare` and `task_answer` response. Every task
requires the exact local `kiokuko-soul`; missing or unknown availability returns
`required_capability_unavailable`, even while intake needs an answer. For a ready
build/debug task with actionable ordinary memory, missing or unknown
`memory-reasoning` alone sets `memoryPolicy.contextWithheld=true`, reports
`memory_reasoning_missing` or `memory_reasoning_unknown` in
`memoryPolicy.withheldReason`, withholds that memory, and leaves `nextAction=proceed` so
the client can continue from repository evidence. When it is available, the
client must read the local `memory-reasoning` Skill before modifying code and
convert recalled claims that affect the task into verified premises, falsifiable
invariants, concrete counterexamples, and regression tests. Catalog availability
alone does not satisfy this execution contract.
`context: null` with `memoryPolicy.contextWithheld=true` is the explicit
withholding state and persists no delivery. A non-null empty context with a null
delivery ID means there was no actionable candidate; clients must not collapse
these states.
If the client cannot obtain the Kiokuko policy for a non-trivial build/debug
request, it must also stop and report that boundary. Repository-only
continuation for such a request is allowed only after the policy establishes
that no Kiokuko memory was delivered or used.

The latest returned `intake.question` is authoritative for every answer. If
`question.options` is non-null, submit exactly one returned option as `value`.
If `options` is null, submit grounded non-empty free text. Repeat the loop until
`intake.status` is `ready` or `exhausted`; `target` and `expected` require
grounded text and are not one-word enums.

Run-bound `memory_checkpoint` has the same intake precondition across MCP,
scoped memory, and the Agent Gateway: only `active` runs may be closed by a
successful checkpoint. If `task_prepare` or `task_answer` returns
`needs_answer` with `nextAction=answer_from_evidence_or_ask_user`, the client
must finish every required `task_answer` question before retrying. The MCP
tool returns `isError=true` with fixed text and structured fields
`code=CHECKPOINT_RUN_NOT_ACTIVE`, `reason`, `runStatus`, `nextAction`, and
`retryableAfterStateChange`; arbitrary internal messages and details are never
forwarded. A terminal run returns `reason=run_terminal` and `nextAction=stop`.

The MCP checkpoint payload is closed and has two forms. A standalone
checkpoint contains at least one memory and omits `runId`, `outcome`,
`deliveryId`, `feedback`, and `evidence`. A run-bound checkpoint requires an
active exact `runId`, an explicit terminal `outcome`, and at least one
non-empty `memories`, `feedback`, or `evidence` lane. Outcome-only, empty
evidence, empty feedback, and invented evidence fields such as `checks` are
invalid. Evidence fields are limited to `changedPaths`, `errorSignatures`,
`commands`, `tests`, and `verification`; feedback items are limited to
`entryId`, `entryRevision`, `verdict`, and `comment`.

## Scope boundary

The stdio MCP server calls Kiokuko's memory services only through
`task_prepare`, `task_answer`, and lifecycle tools. It never exposes the SQLite
file or a direct recall tool. Human/operator CLI and Web inspection remains
management-only. Task context is limited to the resolved current repository
and/or the reserved global workspace; it never searches unrelated project
workspaces. Writes are candidate-only, untrusted, bounded, content-hash
idempotent, audited, and passed through secret detection.

The generic Agent Gateway remains available for explicit execution-ledger
workflows and applies the same task capability gate.
