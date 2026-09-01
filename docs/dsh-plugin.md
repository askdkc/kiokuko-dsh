# DeepSeek Harness Plugin

Kiokuko provides an out-of-tree DeepSeek Harness bundle at
`kiokuko-dsh/dsh`. It mounts the same Kiokuko core contracts used by the
MCP clients; it does not fork DeepSeek Harness or modify a repository's files.

## Install

The published `kiokuko-dsh@0.1.0` npm package is the one-shot path because its
tarball already contains `dist/`:

```bash
pnpm dsh plugin --profile web add kiokuko-dsh
pnpm dsh --profile web --dump-config
```

For a source-pinned Git install, use this fallback. It pins one commit, lets
the first run initialize the profile, adds the exact `allowBuilds` key without
deleting existing entries, and retries automatically:

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
- all fourteen Kiokuko operations, with only the seven model-facing operations
  exposed as model tools and host identity injected after argument validation;
- revision, route, phase, lease, idempotency, confirmation, verifier, and
  meditation gates through the Kiokuko core;
- ordered, idempotent SessionEvent bridging with a final flush before terminal
  ledger close; and
- bounded turn continuation, exact run/session/workspace/route binding, and
  in-memory plaintext continuation tokens.

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
then runs the pack/install/dump-config/remove flow when a `dsh` executable is
available. Without that executable the CLI portion is reported as
`unsupported`; it is not represented as a passing install result.

The current compatibility measurement is:

| Harness profile | Status |
|---|---|
| web | contract covered; DeepSeek CLI runtime not available in this checkout |
| headless | contract covered; DeepSeek CLI runtime not available in this checkout |
| sdk | unsupported until a real Loader/SDK host is supplied |
| acp | unsupported until a real Loader/ACP host is supplied |
| sdk-minimal | unsupported until a real Loader/SDK host is supplied |

The `web` and `headless` labels describe the intended host profiles. They are
not a claim that an external DeepSeek binary was executed in an environment
where it is absent.

## DSH acceptance boundary

DSH acceptance is limited to the DSH surface and the directly relevant
Kiokuko contracts listed by the DSH verifier set. The Core HTTP/Web/TCP suite
is not silently folded into that acceptance boundary: if the host forbids
loopback listeners (for example, with `listen EPERM`), that suite remains
explicitly unverified and is not converted into a skip or a passing result.

The DSH acceptance evidence is therefore reported separately from broader
Core-suite evidence. An unavailable DeepSeek CLI is likewise reported as
`unsupported`, never as a successful install or runtime execution.
