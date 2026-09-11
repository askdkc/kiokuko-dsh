# DeepSeek Harness Plugin

Kiokuko provides an out-of-tree DeepSeek Harness bundle at `kiokuko-dsh`.
`kiokuko-dsh/dsh` remains a compatibility import. It mounts the DSH-only Kiokuko runtime contracts; it does
not fork DeepSeek Harness or modify a repository's files.

## Install

The published `kiokuko-dsh` npm package is the one-shot path when a matching
release is available because its tarball already contains `dist/`:

Run the following from a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a direct GitHub install, run the following from a DeepSeek Harness checkout:

```bash
pnpm dsh plugin --profile web add github:askdkc/kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a source-pinned Git install, use this fallback. It pins one commit, lets
the first run initialize the profile, adds the exact `allowBuilds` key without
deleting existing entries, and retries automatically. Run it from a DeepSeek
Harness checkout:

```bash
set -eu

dsh_profile="$HOME/.dsh/profiles/web"
dsh_workspace="$dsh_profile/pnpm-workspace.yaml"
dsh_commit="$(git ls-remote https://github.com/askdkc/kiokuko-dsh.git HEAD | awk '{print $1}')"
test -n "$dsh_commit"
dsh_spec="github:askdkc/kiokuko-dsh#${dsh_commit}"
dsh_key="kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/${dsh_commit}"

if ! pnpm dsh plugin --profile web add "$dsh_spec"; then
  node --input-type=module - "$dsh_workspace" "$dsh_key" <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [file, key] = process.argv.slice(2);
mkdirSync(dirname(file), { recursive: true });
let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (!text.includes(key)) {
  if (/^allowBuilds:\s*$/m.test(text)) {
    text = text.replace(/^allowBuilds:\s*$/m, (line) => `${line}\n  "${key}": true`);
  } else if (/^allowBuilds:\s*\{\}\s*$/m.test(text)) {
    text = text.replace(/^allowBuilds:\s*\{\}\s*$/m, `allowBuilds:\n  "${key}": true`);
  } else {
    text += `${text.endsWith('\n') || text.length === 0 ? '' : '\n'}allowBuilds:\n  "${key}": true\n`;
  }
  writeFileSync(file, text);
}
NODE
  pnpm dsh plugin --profile web add "$dsh_spec"
fi
pnpm dsh --profile web --dump-config
```

With an installed dsh CLI, use the same commands without the `pnpm` launcher.

### Local checkout

Build in the Kiokuko checkout before installing it:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Then install the built directory using the installed DSH CLI (prefix `dsh` with
`pnpm` when running from a DSH checkout):

```bash
dsh plugin --profile web add /absolute/path/to/kiokuko-dsh
dsh --profile web --dump-config
```

## Update

Finish active tasks and stop DSH before changing installed packages. Kiokuko has
no standalone setup/update CLI: [DSH plugin management](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
forwards package commands to pnpm in the selected profile. The commands below use
an installed `dsh`; prefix them with `pnpm` when running from a DSH checkout.

For an npm-installed Kiokuko, update the plugin itself:

```bash
dsh plugin --profile web update kiokuko-dsh --latest
```

For Orca dependency updates, the installed Kiokuko must contain the `>=0.2.1`
ranges for `@orcareplay/core`, `@orcareplay/schema`, and `@orcareplay/viewer`.
An older Kiokuko that pins 0.2.1 must be updated first. After a new Orca release
is published, refresh the Orca dependency graph and inspect the resolved versions:

```bash
dsh plugin --profile web update --depth Infinity '@orcareplay/*'
dsh plugin --profile web why @orcareplay/core
dsh plugin --profile web why @orcareplay/schema
dsh plugin --profile web why @orcareplay/viewer
dsh web
```

The quoted pattern selects Orca packages; `--depth Infinity` includes indirect
dependencies. This is an explicit [pnpm update](https://pnpm.io/11.x/cli/update),
not an update on every startup. `>=0.2.1` permits stable 0.3.0 and later releases
but excludes prereleases such as `0.3.0-rc.1`. Existing lockfiles retain their
previous resolutions until updated. Future API compatibility is not guaranteed;
after restarting, check a new recording with `/kioku-orca list`, `show`, and
`export` as described in the [Orca guide](orca-recording.md).

For a commit-pinned Git install, use the source-pinned installation procedure
above with the intended new commit; updating a fixed source reference does not
move it to a newer commit. For a local checkout, update/build that checkout and
install its built path again. These profile commands do not update the lockfiles
in a separate Kiokuko development checkout.

## Remove

```bash
dsh plugin --profile web remove kiokuko-dsh
```

## Usage

Do not run `/kiokuko-soul`. The plugin mounts the bundled `kiokuko-soul` content
as the `kiokuko:soul` system-prompt section automatically. Start the selected
DSH profile and enter your task, for example:

```bash
dsh web
```

The package exposes `.`, `./client`, and `./dsh` and declares
`dsh/cordis.patch.yml` as its bundle patch. Use a profile when testing or when
you need an isolated configuration:

```bash
dsh plugin --profile kiokuko-test add github:askdkc/kiokuko-dsh
dsh --profile kiokuko-test --dump-config
dsh plugin --profile kiokuko-test remove kiokuko-dsh
```

A DSH session can use a Git repository, a `.kiokuko.json`-bound project, or an
ordinary directory as its workspace. For an ordinary directory, Kiokuko keeps
the path binding in its database and does not create `.git`, `.kiokuko.json`,
or any other metadata file in the workspace.

`kiokuko-dsh` disables the existing `session-log-download` Host row and inserts
its own row under the stable `kiokuko-dsh` id. Its DSH lazy-CJS client owns the
Header modal and `/export` command UI while the Host route uses cursor-backed
streaming export. Removing the bundle restores the stock row without rewriting
unrelated plugins or settings. The plugin does not edit `AGENTS.md`.

## Bundled standard Skills: canonical source and refresh

The repository's `skills/<name>/` directories are the single canonical source
for the six standard Skills and for the bundled Japanese output Skill.
`src/dsh/standard-skills.ts` resolves them relative to the built module
(`dist/dsh/` → `../../skills/<name>`), and `src/dsh/standard-skill-integrity.ts`
refuses to load a tree that breaks the manifest: exactly one management marker
per file, frontmatter `name` equal to the manifest name with a non-empty
description and no `disable-model-invocation`, every local Markdown link
resolvable inside its own Skill, and exactly 6 Skills with 21 Markdown files and
15 reference files.

Because the package ships that tree, a plugin upgrade is what refreshes a
deployed copy: bump the package version and reinstall the plugin
(`pnpm dsh plugin --profile web add kiokuko-dsh` after publishing, or the
GitHub/commit-pinned install from **Install**). A working directory that keeps an
independent copy of these Skills, such as an agent-level Skills directory, is
*not* written by this repository and drifts independently; after changing a
Skill, refresh that copy from this tree and confirm it matches, or delete it so
only the plugin's bundled content is used.

Vocabulary is fixed by the implementation: `task_prepare` and `task_answer` are
host operations performed by the DSH host before the model request, not model
tools, and no model-side attestation field is required. Skill text that asks the
model to call those tools, or to create its own `requestId`, belongs to an older
deployment and must not be reintroduced.

### Regenerate and verify

```bash
npm run build
node scripts/verify-standard-skills.mjs
```

The script loads the parity from `dist/` and fails unless the counts are 6
Skills, 21 Markdown files, and 15 reference files; it prints the Skill names,
counts, and the content digest that changes on every Skill edit. Compare the
digest before and after a Skill change to confirm which deployment is stale.

## STORE contract and permissions

This package intentionally targets the DSH STORE `user-reviewed` track. Its
source and npm tarball are larger than the STORE automatic-review size bound;
that bound is a catalog automation limit, not a runtime or npm packaging
limit. The package is therefore not represented as a small, auto-approved
plugin.

The manifest declares MIT licensing, the canonical GitHub repository, Node.js
`>=24.16.0`, DSH `0.1.2-rc.1`, and the verified `web` profile. Other DSH
releases and `headless` remain unverified until a matching disposable-profile
run is recorded.

Runtime effects are explicit:

- local reads and writes are limited to the configured Kiokuko data directory,
  SQLite state, backups, runtime descriptors, registered project roots, and
  Kiokuko-managed instruction files;
- repository-relative verifier and backup subprocesses are restricted and are
  never an implicit model-facing shell tool;
- Skill discovery/source retrieval and remote embeddings can use the network,
  but remote embeddings are disabled by default; and
- optional GitHub or embedding credentials are supplied by the user and are
  never bundled or persisted by the plugin.

`prepare` runs only `npm run build`. A Git install must be pinned to one full
commit and may require this exact pnpm permission in the consuming profile:

```yaml
allowBuilds:
  "kiokuko-dsh@https://codeload.github.com/askdkc/kiokuko-dsh/tar.gz/<commit>": true
```

The npm tarball already contains `dist/`, so its normal install path does not
depend on a consumer-side build permission.

## Runtime contract

The Core SQLite database remains the semantic authority for Akinator, memory,
Enno-Oduno, receipts, leases, and verifier evidence. DeepSeek `SessionEvent`
is the canonical current-session transcript and tool-evidence boundary.
Kiokuko copies events and verified attachment bytes into a separate,
rebuildable cache for bounded export and post-completion finalization. Cache
listeners contain their own failures; only an orchestration-requested native
`sessions.flush()` remains an awaited, fail-closed durability boundary.

The dsh integration provides:

- the exact bundled `kiokuko-soul` system-prompt section and six standard Skill
  providers;
- named context fragments deduplicated against the retained native conversation
  and current message batch. Turns and phase changes append only changed
  fragments; the SOUL body stays in the system prompt. Compaction, session resume,
  and plugin reload restore missing fragments from current host state. A proposed
  message is not treated as delivered until the native loop retains or queues it;
- the original human request and attachments remain native messages. Kiokuko's
  task context contains only additional intake facts, omitting exact request
  copies and request prefixes in those fields;
- one current Akinator question at a time only when the task type remains
  ambiguous; the canonical workspace and exact user request ground the target
  and completion fields without asking the user to repeat known context, and
  unresolved intake blocks the model and tools;
- Japanese task-type labels with concrete examples and guidance distinguishing
  file changes from drafting text. Kiokuko's initial Web question supports
  number keys 1–8 to select and Enter to confirm; digits entered in the custom
  field (including full-width digits) resolve in the same displayed order.
  Shift+Enter and IME composition do not submit. Pending drafts survive a
  Session switch, and other plugins' questions and plan-approval cards retain
  their native UI;
- an explicit `chat` intake choice (including free-form aliases such as
  `just chatting` and `雑談`) and the task-type question's **Skip this
  question** action; both skip target/success follow-ups and never create an
  Enno-Oduno contract, and the chat choice carries across conversational
  follow-ups until an explicit actionable request starts a new run;
- the Kiokuko operations, with only the eight model-facing operations
  exposed as model tools and host identity injected after argument validation;
- host-bound capability catalogs are carried into plan submission, while
  advisory digests remain host-owned and the current model reports only its
  per-slot advisory dispositions after receiving the bounded advisory evidence;
- Oduno ideal directives distinguish the mandatory Skill reading list from
  Akinator-discovered Skill contributions, constrain the latter to the exact
  selected names (including an exact empty list), and return bounded corrective
  field diagnostics to DSH when a submission is rejected;
- request-scoped Ponytail state for concurrent DSH conversations, with native
  commands routed to the exact invoking agent and session;
- revision, route, phase, lease, idempotency, confirmation, verifier, and
  meditation gates through the Kiokuko core;
- final verification compares the workspace at verification start, so completed
  implementation edits are allowed. Git and ordinary directories use the same
  file selection as their repository snapshots; unchanged content and ignored
  build output do not trigger plan approval. Actual source changes still
  invalidate evidence, while an unavailable mutation audit stops with a host
  error instead of requesting another plan or repeating completed work;
- a non-terminal tool result whose next action requires host work (plan confirmation or
  final verification) calls DSH `concludeTurn()` only after
  the successful result exists. Plan submission therefore concludes its model
  step before DSH opens a dedicated `plan-review` interaction. Receipt,
  handoff, outbox, and seal commit atomically; a separate durable job then owns
  approval or cancellation. `agent/turn-stopping` only kicks that worker, so no model tool call remains
  live while the user decides and no stale confirmation directive can race the
  next Goki role. The card offers approve/cancel; **Chat about it** returns the
  normal composer, and the next human message becomes same-run revision
  feedback before Zenki resumes. DSH defines the card chrome from its own UI
  locale, while Kiokuko supplies the plan body as Markdown. Kiokuko derives an
  English or Japanese body language from the original task, instructs Zenki to
  keep every natural-language plan field in that language, and renders headings,
  lists, paths, commands, dependencies, checks, and limits without changing the
  DSH `plan-review` intent or decision labels;
- a durable run-to-`turn/start` binding and an immutable terminal `turn/end`
  boundary. A successful Oduno meditation result deliberately does not call
  `concludeTurn()`: the same native turn remains open for one visible assistant
  response summarizing the outcome, changes, verification, and remaining
  uncertainty. On the resulting genuinely terminal idle boundary, the adapter
  awaits DSH's exact live `sessions.flush(session)` before the ledger close,
  including the tool result and that final assistant/turn suffix. The
  background finalizer reads only that inclusive range even if the session has
  already received later turns. If the final response is empty or its provider
  fails, a durable plugin-owned result appears in chat, using recorded work,
  verification, and remaining issues. It does not impersonate a model message
  or make another model request. The fallback remains visible after reload;
- bounded turn continuation, exact run/session/workspace/route binding, and
  in-memory plaintext continuation tokens.

Natural model stops before a required phase submission enter the same durable
three-delivery loop guard. Boundary workers serialize per session, not across
unrelated sessions. New human input aborts pending questions and supersedes old
jobs; delivery rechecks ownership after native flushing. Future retry times and
expired-owner recovery are scheduled from the database after restart as well
as during normal operation.

CI requires full native-loop coverage against the pinned published runtime,
including natural stops, identical work-report retries, approval cancellation,
and both empty and failed final responses. Package installation alone is not
treated as proof of workflow completion.

Expected validation or omission failures become bounded retry receipts. The
first identical failure retries the same phase with temporary evidence; the
second asks Akinator. A deterministic continuation is delivered only after a
native flush. Human input supersedes a pending continuation, and plugin delivery
IDs alone are deduplicated at the next pre-step.

A DSH model-request failure, including a WebSocket failure, also leaves an
unfinished Enno run active and does not automatically replay model or tool
work. When the user continues in a later turn, the adapter revalidates the exact
DSH session, contract revision, and current WorkUnit, then rotates its execution
lease before reinjecting the directive. Recovery therefore remains available
after the old 15-minute lease expires without allowing an older turn to report.

Ordinary chat remains open while the agent is idle between conversational
messages. An explicit build, debug, review, research, writing, analysis, or
DevOps request closes the preceding chat run before starting its task run.
An unfinished, resumable non-chat run remains bound across later user turns so
a follow-up instruction does not orphan the existing plan. Completed,
cancelled, and blocked runs are closed before the next independent request
starts; blocked runs retain their failed ledger outcome rather than lingering
as unusable active bindings. Disposing the DSH session closes its current run
after queued events are durable.

Short status checks such as `all fixed?` are classified as analysis rather than
as a new fix request, and commit-message requests are classified as writing.
If either arrives while an earlier Enno run is still at the unstarted Oduno
ideal boundary, the old run is cancelled and the explicit lightweight request
starts independently instead of being trapped inside that contract.

After a plugin reload or process restart has cleared in-memory turn state, the
adapter resumes only the single unambiguous active Enno-Oduno run already bound
to the same persistent DSH session and canonical repository. The session is
revalidated through the core continuation gate, persisted pending advisory evidence is restored once, and
previous ordinary-memory context is not replayed implicitly. Multiple matching
runs, a continuation limit, a conflicting execution lease, or a changed
capability catalog still fails closed instead of selecting or advancing a run.
User questions retain the exact live native Agent object; confirmation answers
revalidate both that scope and the bound catalog/revision before they can mutate
the core state machine.

`runId` is required for dsh resume. The plugin never selects a repository-wide
latest run. Ambiguous, stale, cancelled, aborted, lease-conflicting, or
unavailable states stop without converting the failure into a normal success.

## Verification

From the Kiokuko checkout:

```bash
npm run test:e2e:dsh
```

This builds the package, runs the Cordis composition test with an in-memory
host adapter, validates model/tool/question/ledger/turn-end boundaries, and
then runs the pack/install/dump-config/Web-start/Web-stop/remove flow when a
`dsh` executable is available. When `DSH_BIN` points into a local DeepSeek
Harness source checkout (or `KIOKUKO_DSH_SOURCE_ROOT` is set), it also resumes a
persisted pending advisory round and runs two consecutive full Enno agent-loop
flows through intake, ideal, planning, dedicated review, work reporting, final
verification, advisory disposition, meditation, native DSH checkpoint,
terminal close, and post-completion memory finalization. The second flow
dismisses review, carries revision feedback through the
next human turn, resubmits, and approves before work starts. It then handles
consecutive `all fixed?` and commit-message turns without creating another Enno
contract. The first flow includes a long streamed response and verifies that
no DSH events are copied into the Kiokuko ledger; the rebuildable mirror retains
them for cursor-backed finalization/export and records cache usage. Without a dsh executable the CLI portion is reported
as `unsupported`; CI sets `KIOKUKO_REQUIRE_DSH_CLI=1` so absence is a failure
rather than an unverified success.

The current compatibility measurement is:

| Harness profile | Status |
|---|---|
| web | verified by the disposable rc.1 install/start/uninstall run |
| headless | unknown; not declared as supported |
| sdk | unsupported until a real Loader/SDK host is supplied |
| acp | unsupported until a real Loader/ACP host is supplied |
| sdk-minimal | unsupported until a real Loader/SDK host is supplied |

The `web` status is evidence-based only after the disposable rc.1 run. An
unavailable DeepSeek binary leaves a profile unverified; it is never converted
into a passing runtime claim.

## DSH acceptance boundary

DSH acceptance is limited to the DSH surface and the directly relevant
Kiokuko contracts listed by the DSH verifier set. There is no generic Kiokuko
HTTP, TCP, or standalone Web product surface in this package. The only Web
lifecycle checked here is the DeepSeek Harness `web` profile loading and
unloading this plugin. An unavailable DeepSeek CLI is reported as
`unsupported`, never as a successful install or runtime execution.

## OrcaReplay recording

Orca dependencies and recording configuration are installed automatically with
this package; the feature is **enabled by default**. At the first native step,
a session-scoped question asks whether to record. Only an affirmative choice
starts capture; skipping or an unavailable question UI continues without recording.
The choice survives reloads. The first subsequent model/tool observation creates
`.orca/runs/` in the verified session workspace. Set `config.orca.enabled: false` and reload to disable
recording. `/kioku-orca stop`, `list`, `show <run ID>` and
`export <run ID>` finalize and inspect the selected session's trace. This records
DSH internal events, not a complete replayable HTTP/filesystem capture.
See [Orca recording](orca-recording.md) for configuration, limits, sensitive data,
storage, disabling and removal.
