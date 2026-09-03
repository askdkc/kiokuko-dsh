# DeepSeek Harness Plugin

Kiokuko provides an out-of-tree DeepSeek Harness bundle at
`kiokuko-dsh/dsh`. It mounts the same Kiokuko core contracts used by the
MCP clients; it does not fork DeepSeek Harness or modify a repository's files.

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
rewrite unrelated plugins or settings. The plugin itself never runs `kiokuko
setup`, changes MCP configuration, or edits `AGENTS.md`.

## STORE contract and permissions

This package intentionally targets the DSH STORE `user-reviewed` track. Its
source and npm tarball are larger than the STORE automatic-review size bound;
that bound is a catalog automation limit, not a runtime or npm packaging
limit. The package is therefore not represented as a small, auto-approved
plugin.

The manifest declares MIT licensing, the canonical GitHub repository, Node.js
`>=24.16.0`, DSH `0.1.2-alpha.5`, and the verified `web` profile. Other DSH
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
- one current Akinator question at a time, with unresolved intake blocking the
  model and tools;
- an explicit `chat` intake choice (including free-form aliases such as
  `just chatting` and `雑談`) and the task-type question's **Skip this
  question** action; both skip target/success follow-ups and never create an
  Enno-Oduno contract, and the chat choice carries across later messages in
  the same DSH conversation;
- all fourteen Kiokuko operations, with only the seven model-facing operations
  exposed as model tools and host identity injected after argument validation;
- revision, route, phase, lease, idempotency, confirmation, verifier, and
  meditation gates through the Kiokuko core;
- ordered, idempotent SessionEvent bridging with a final flush before terminal
  ledger close; and
- bounded turn continuation, exact run/session/workspace/route binding, and
  in-memory plaintext continuation tokens.

Ordinary chat remains open while the agent is idle between messages. Each
DSH conversation keeps one intake answer and one ledger run so every later
message and ordered session event stays bound to the same conversation.
Disposing the DSH session closes that chat run after its events are durable.

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
`dsh` executable is available. Without that executable the CLI portion is
reported as `unsupported`; CI sets `KIOKUKO_REQUIRE_DSH_CLI=1` so absence is a
failure rather than an unverified success.

The current compatibility measurement is:

| Harness profile | Status |
|---|---|
| web | verified by the disposable alpha.5 install/start/uninstall run |
| headless | unknown; not declared as supported |
| sdk | unsupported until a real Loader/SDK host is supplied |
| acp | unsupported until a real Loader/ACP host is supplied |
| sdk-minimal | unsupported until a real Loader/SDK host is supplied |

The `web` status is evidence-based only after the disposable alpha.5 run. An
unavailable DeepSeek binary leaves a profile unverified; it is never converted
into a passing runtime claim.

## DSH acceptance boundary

DSH acceptance is limited to the DSH surface and the directly relevant
Kiokuko contracts listed by the DSH verifier set. The Core HTTP/Web/TCP suite
is not silently folded into that acceptance boundary: if the host forbids
loopback listeners (for example, with `listen EPERM`), that suite remains
explicitly unverified and is not converted into a skip or a passing result.

The DSH acceptance evidence is therefore reported separately from broader
Core-suite evidence. An unavailable DeepSeek CLI is likewise reported as
`unsupported`, never as a successful install or runtime execution.
