# DeepSeek Harness Plugin

Kiokuko provides an out-of-tree DeepSeek Harness bundle at
`kiokuko-dsh/dsh`. It mounts the DSH-only Kiokuko runtime contracts; it does
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

## Usage

Do not run `/kiokuko-soul`. The plugin mounts the bundled `kiokuko-soul` content
as the `kiokuko:soul` system-prompt section automatically. Start the selected
DSH profile and enter your task, for example:

```bash
dsh web
```

The package exposes the `./dsh` entrypoint and declares
`dsh/cordis.patch.yml` as its bundle patch. Use a profile when testing or when
you need an isolated configuration:

```bash
dsh plugin --profile kiokuko-test add github:askdkc/kiokuko-dsh
dsh --profile kiokuko-test --dump-config
dsh plugin --profile kiokuko-test remove kiokuko-dsh
```

`kiokuko-dsh` is the single named bundle row. Removal is exact and does not
rewrite unrelated plugins or settings. The plugin does not edit `AGENTS.md`.

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

The SQLite database remains the semantic authority for Akinator, memory,
Enno-Oduno, receipts, leases, and verifier evidence. DeepSeek `SessionEvent`
is the current-session ordered transcript and tool-evidence boundary. Events
are observed after the host commit, while session flush, model dispatch, tool
execution, and turn stopping are awaited durability or policy boundaries.

The dsh integration provides:

- the exact bundled `kiokuko-soul` system-prompt section and six standard Skill
  providers;
- one current Akinator question at a time only when the task type remains
  ambiguous; the canonical workspace and exact user request ground the target
  and completion fields without asking the user to repeat known context, and
  unresolved intake blocks the model and tools;
- an explicit `chat` intake choice (including free-form aliases such as
  `just chatting` and `雑談`) and the task-type question's **Skip this
  question** action; both skip target/success follow-ups and never create an
  Enno-Oduno contract, and the chat choice carries across conversational
  follow-ups until an explicit actionable request starts a new run;
- all fourteen Kiokuko operations, with only the seven model-facing operations
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
- a tool result whose next action requires host work (plan confirmation or
  final verification), or is terminal, calls DSH `concludeTurn()` only after
  the successful result exists. Plan submission therefore concludes its model
  step before DSH opens a dedicated `plan-review` interaction. Approval or cancellation is then
  settled at the awaited turn-stopping boundary, so no model tool call remains
  live while the user decides and no stale confirmation directive can race the
  next Goki role. The card offers approve/cancel; **Chat about it** returns the
  normal composer, and the next human message becomes same-run revision
  feedback before Zenki resumes. DSH defines the card chrome from its own UI
  locale, while Kiokuko supplies the plan body as Markdown. Kiokuko derives an
  English or Japanese body language from the original task, instructs Zenki to
  keep every natural-language plan field in that language, and renders headings,
  lists, paths, commands, dependencies, checks, and limits without changing the
  DSH `plan-review` intent or decision labels;
- ordered, idempotent SessionEvent bridging that retains the pre-binding turn
  prefix, drains long model streams in bounded batches, preserves every valid
  source-event reference, and flushes only the exact bound run at each DSH
  checkpoint. On every idle boundary, the adapter awaits DSH's exact live
  `sessions.flush(session)` before any terminal ledger close, including the tool
  result and final assistant/turn events after Oduno meditation; and
- bounded turn continuation, exact run/session/workspace/route binding, and
  in-memory plaintext continuation tokens.

If the model stops while an Enno action is still active, the adapter steers the
same native turn only once for that unchanged directive. A second stop pauses
the turn without cancelling or terminalizing the Enno run. The next user turn
then resumes that exact run and reinjects its current directive. This recovery
also works when DSH exposes an empty step-local message batch after consuming
the next-turn inbox item: the adapter uses the last bound task for routing while
the native conversation still carries the user's new instruction to the model.
For an unchanged `execute_work_unit` action, the continuation explicitly tells
the model to inspect the latest Enno tool result and retry the current WorkUnit;
it must not wait for an invented next WorkUnit.

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
verification, advisory disposition, meditation, transcript flush, and terminal
close. The second flow dismisses review, carries revision feedback through the
next human turn, resubmits, and approves before work starts. It then handles
consecutive `all fixed?` and commit-message turns without creating another Enno
contract. The first flow includes a streamed response large enough to cross the
bridge's batching boundary. Without a dsh executable the CLI portion is reported
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
