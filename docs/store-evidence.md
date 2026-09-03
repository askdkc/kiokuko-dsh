# DSH STORE evidence record

This document is the release checklist for the DSH STORE `user-reviewed`
listing. It is intentionally separate from the runtime contract: the STORE
must be able to review the exact source Commit, package metadata, lifecycle,
permissions, and disposable-profile result independently.

## Fixed release identity

| Field | Value |
|---|---|
| Package | `kiokuko-dsh` |
| Repository | `https://github.com/askdkc/kiokuko-dsh` |
| Release | `0.1.3` |
| DSH release | `0.1.2-alpha.5` |
| Profile | `web` |
| npm lifecycle | `prepare: npm run build` |
| Automatic size policy | intentionally exceeded; manual `user-reviewed` track |

The Commit field is filled only after the user commits and pushes the verified
working tree. The catalog must point to that full immutable Commit, not a branch
name or moving tag.

```text
Commit: <fill after user push>
Evidence run: <fill with CI URL or artifact URL>
```

## Required evidence

The CI evidence must use a disposable `DSH_HOME` and record Node.js version,
OS, DSH version, package version, exact package Commit, clean source state,
packed-artifact integrity, and these outcomes without credentials:

1. the reproducibility check proves that `prepare` emits the same `dist/` tree
   from the fixed source;
2. the package check builds a tarball containing the declared runtime closure
   and imports `kiokuko-dsh/dsh` from an isolated consumer;
3. the disposable Profile installs that exact tarball;
4. `dump-config` contains exactly one `kiokuko-dsh/dsh` bundle;
5. the DSH `web` profile cold-starts and reports the plugin loaded;
6. the profile stops cleanly;
7. removing the plugin leaves no `kiokuko-dsh` bundle in `dump-config`.

The test must fail if the DSH CLI is unavailable. `headless`, SDK, ACP, and
other DSH releases remain `unknown` until they receive their own evidence.

## Review interpretation

The source file count and byte total exceed the DSH STORE automatic-review
bound. This is expected and is not a request to remove runtime assets. The
review decision must instead remain `status: approved` with
`updatePolicy: user-reviewed`, retaining the declared dependency, permission,
and lifecycle disclosures for every future fixed-Commit update.
