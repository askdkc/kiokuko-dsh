# Kiokuko DSH permissions

Kiokuko DSH is a local-first DeepSeek Harness suite. The DSH host owns profile
lifecycle and the plugin only uses the effects required by the selected
Kiokuko operation.

## Local data

- Reads configured Kiokuko SQLite state, registered project roots, and
  repository metadata.
- Writes the configured Kiokuko database and pre-migration backups, including
  DSH leases, receipts, retrieval state, and embedding state.
- Does not rewrite host configuration or repository instruction files.
  Repository identity, run identity, lease, revision, and integrity mismatches
  fail closed.

## Processes and network

- Repository-relative final verifiers and backup operations may run restricted
  subprocesses only when the corresponding Kiokuko operation explicitly
  requests them. The plugin does not provide an implicit model-facing shell
  tool.
- Skill discovery and source retrieval can contact GitHub or skills.sh when
  enabled by configuration.
- Remote embedding requests can contact the configured endpoint. Remote
  embeddings are disabled by default; local embedding state remains separate.

## Credentials and optional dependencies

- GitHub and embedding credentials are optional user-provided environment or
  configuration values. They are not bundled in the package and are not
  persisted by the plugin.
- `@huggingface/hub`, `@huggingface/transformers`, and `sqlite-vec` are optional
  peer capabilities. They are not silently installed by the minimal package
  path and are required only by the feature that explicitly uses them.
- `@deepseek-ai/cordis` is the host peer dependency. The package does not
  replace or patch the host runtime outside its declared DSH bundle patch.

## Installation lifecycle

The only npm lifecycle hook is:

```text
prepare = npm run build
```

It builds the package from the fixed source checkout. It does not modify a DSH
profile, contact an external service, or edit user configuration. A Git source
install must pin a full commit and authorize the exact generated archive key
with pnpm `allowBuilds`; the npm tarball already contains `dist/`.

## Failure boundaries

Missing optional dependencies, unavailable external services, stale or
ambiguous run state, failed verifier processes, and integrity or ownership
conflicts are reported as failures or unavailable states. They are never
converted into normal success or silently redirected to another repository or
run.
