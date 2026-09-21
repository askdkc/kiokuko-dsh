# Dependency security status

Checked on 2026-09-22. These findings apply to this repository's development
dependency graph and its CI configuration. Root npm/pnpm overrides do not
propagate to an application's dependencies when Kiokuko is installed as a plugin.

| Dependabot alerts | Dependency | Repository action |
| --- | --- | --- |
| #1: GHSA-xcpc-8h2w-3j85 | adm-zip < 0.6.0 | Pin 0.6.1 in npm and pnpm. |
| #2: GHSA-f88m-g3jw-g9cj | sharp < 0.35.0 | Pin 0.35.4 in npm and pnpm. |
| #5: GHSA-rgj7-g3m4-5g8c | sharp < 0.35.4 | Pin 0.35.4 in npm and pnpm. |
| #3 / #4: GHSA-vwc7-r8mq-g2x9 | adm-zip 0.5.9–0.6.0 | Unfixed upstream; CI avoids the affected installer path. |
| #7: GHSA-7q85-xj36-vmfc | adm-zip < 0.6.1 | Pin 0.6.1 in npm and pnpm; check the crafted ZIP without allowing oversized allocations. |

The [memory-allocation advisory](https://github.com/advisories/GHSA-7q85-xj36-vmfc)
lists 0.6.1 as its first patched version. Both lockfiles and the installed
ONNX dependency must resolve that version; changing only an override is insufficient.

`@huggingface/transformers@4.2.0` depends on sharp and on
`onnxruntime-node@1.24.3`. ONNX Runtime uses adm-zip in its optional binary
download installer. That installer creates a timestamp-based temporary
directory and calls `extractEntryTo` with overwrite enabled. An existing
symlink inside that directory can redirect the write outside it.

The [symlink advisory](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)
still lists no patched version as of the check date. Its affected-version range
ends at 0.6.0, so an audit that excludes 0.6.1 does not establish that symlink
extraction is fixed. Keep the installer mitigation until that fix is verified.
Neither the alerts nor audit findings are dismissed or excluded.

CI sets `ONNXRUNTIME_NODE_INSTALL=skip` for all jobs and their child processes.
For pinned ONNX Runtime 1.24.3, the only additional download manifest is
Linux x64 CUDA 12; CPU binaries for the CI platforms are already bundled.
The setting prevents this installer's downloads and ZIP extraction. It does
not patch adm-zip or protect another program that directly calls its extraction
APIs, and it does not configure a user's DSH profile or GPU installation.

For a source checkout that uses the bundled CPU runtime, the same mitigation is:

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
```

Or, for a pnpm-managed checkout:

```sh
ONNXRUNTIME_NODE_INSTALL=skip pnpm install --frozen-lockfile
```

Keep the setting on every reinstall. Use a private, non-shared installation
directory. GPU users need a separately reviewed installation path until an
upstream fix is released; the CI setting is not a complete vulnerability fix.

`tests/dsh/unit/dependency-security.test.ts` checks both lockfiles, the actual
Transformers dependency versions, image/ZIP API compatibility, the advisory's
crafted ZIP with allocation guards in a child process, actual bundled CPU
inference, and the installer skip path with a blocked-network negative control.
When a symlink extraction fix is published, update both override definitions
and lockfiles, rerun those checks and both audits, and re-evaluate the temporary
CI mitigation.
