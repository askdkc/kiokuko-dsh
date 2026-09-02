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
| Release | `0.1.0` |
| DSH release | `0.1.2-alpha.3` |
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
OS, DSH version, package Commit, and these outcomes without credentials:

1. pinned Git install without the exact `allowBuilds` entry is rejected or
   remains unusable;
2. adding the exact `allowBuilds` entry permits the fixed source build;
3. `dump-config` contains exactly one `kiokuko-dsh/dsh` bundle;
4. the DSH `web` profile cold-starts and reports the plugin loaded;
5. the profile stops cleanly;
6. removing the plugin leaves no `kiokuko-dsh` bundle in `dump-config`.

The test must fail if the DSH CLI is unavailable. `headless`, SDK, ACP, and
other DSH releases remain `unknown` until they receive their own evidence.

## Review interpretation

The source file count and byte total exceed the DSH STORE automatic-review
bound. This is expected and is not a request to remove runtime assets. The
review decision must instead remain `status: approved` with
`updatePolicy: user-reviewed`, retaining the declared dependency, permission,
and lifecycle disclosures for every future fixed-Commit update.
