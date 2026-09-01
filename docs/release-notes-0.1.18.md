# Kiokuko 0.1.18

## External Skills

- Added bounded provider search, commit-pinned source validation, chunk limits, snapshot idempotency, and shared discovery single-flight.
- Added `kiokuko skills find|import|list|show|refresh|disable|enable|prune-cache`.
- Manual Skill import is now create-only and accepts only an exact locally
  reviewed catalog identity. Re-importing an existing identity is a conflict;
  use `skills refresh` for an existing managed Skill.
- Akinator discovery and `kiokuko skills find` now use one shared provider-backed search operation; the temporary capability-fallback response was removed.
- Akinator task preparation now defaults to reference-only `official` discovery; `off` remains available and `community` remains explicit opt-in.
- Interactive setup now asks before enabling audited community discovery and persists the selected mode in each managed MCP client configuration; batch setup uses `--skill-discovery`.
- Added authenticated local Web UI/API visibility for imported external skills.
- Disabled, stale, blocked, and unmanaged external references are excluded from retrieval and Curator globalization.
- Community-mode candidates fail closed without a successful provider audit.
- Unknown capability catalogs now force official-only discovery; imported Skill
  reuse requires explicit applicability and mode-compatible provenance.
- Multiple relevant Skills can be imported from one repository, and lifecycle
  CLI commands resolve both internal IDs and `owner/repository/skill` paths.
- Task preparation replay identity now includes the effective discovery mode
  and a bounded normalized capability-catalog hash, so changed discovery input
  cannot reuse an older context delivery.
- `task_prepare` now requires a bounded client-generated `requestId`. The same
  ID and bound input replay one run; a changed bound request under that ID
  conflicts, while a new ID opens a distinct run even for identical task text.
  The raw ID is not stored and `client.sessionId` is not used as a turn ID. The
  normalized context budget is bound and must match on `task_answer`.
- Generated agent/setup/MCP contracts now require an available local
  `memory-reasoning` Skill to be read before code modification and recalled
  claims to be converted into verified premises, invariants, counterexamples,
  and regression tests; availability alone is not compliance.
- A v1 provider response with exact HTTP 401 authentication failure falls back
  once per query to the Compatibility Provider, with provider-separated
  negative and result caches. Other authentication and protocol failures stop.
- Removed legacy fixed-source sync and guessed-source fallback. Bounded exact
  verification of reviewed catalog-pinned sources remains. The ungated
  `guide context` compatibility command was removed; task-aware ContextBroker
  output is capability-gated.

External skills remain untrusted candidate references. Kiokuko does not install,
execute, verify, globalize, or register fetched skill content automatically.

## Fail-closed storage and setup

- Fixed Windows OpenCode setup writing MCP configuration, global instructions,
  and bundled skills under `%APPDATA%\opencode`; setup now follows OpenCode's
  XDG global directory resolution.
- Setup now rejects duplicate or semantically colliding JSON/TOML configuration,
  malformed UTF-8, symlink escapes, and concurrent target changes before it can
  silently merge or overwrite them. Exact concurrent `use` results converge once;
  incompatible state remains an explicit conflict.
- Migration and repository transactions now surface rollback failures, and
  verified pre-migration backups complete before any schema mutation.
- Node.js 24.16 is now the minimum runtime. Manual and pre-migration SQLite
  backups serialize the exact already-open connection and install a verified,
  create-only artifact; the retired pathname-reopening backup subprocess and
  overwrite behavior were removed. `kiokuko backup` no longer initializes or
  migrates its source.
- Project binding rejects the reserved global identity. Forced rebinding now
  requires a distinct repository/workspace pair and performs an exact database
  location compare-and-swap or fails; it never mutates a repository workspace
  in place or silently retains the old identity. Moving `agentFile` removes
  only the old marked block, preserves human bytes and mode, and conditionally
  restores all owned file mutations if a later step fails. Skipping an agent
  write rejects any stale managed block at the prospective target.
- Repository binding/template versions are downgrade-protected across files and
  SQLite metadata. Missing, malformed, corrupt, or future version metadata fails
  explicitly. An indeterminate SQLite commit is surfaced as such and retains
  the matching installed files instead of risking split-brain compensation.
- Stored revision chains, hashes, structured scope, projections, and context
  replay state are validated from their exact persisted identities. Corruption
  fails explicitly instead of being skipped or normalized into a new identity.
- Migration 012 validates the persisted structural identity of released
  `context-ranking-v2` and `context-ranking-v3` scoped deliveries during setup.
  Original delivery IDs, policy versions, character metadata, delivery items,
  and all historical references are preserved. Legacy preview text was not
  persisted and is not reconstructed during upgrade. Legacy deliveries remain
  available for audit and feedback references but are never replayed as current
  `context-ranking-v4` context; invalid persisted legacy structure aborts the
  migration transaction. New scoped deliveries continue to use
  `context-ranking-v4`.
- Migration 009 transactionally rewrites the one exact released locale-ordered
  revision preimage to the canonical hash and scope. Forged preimages and
  canonical collisions abort the upgrade; runtime compatibility hashing was
  removed completely.
- Workspace archive v2 is intentionally limited to revision-1 current state.
  Import/export use one strict canonical format, bounded input, complete secret
  scanning, snapshot-consistent reads, and create-only output. Use a full SQLite
  backup when immutable revision history must be preserved.

## Model task boundary

- Removed the direct model-facing `memory_recall` and
  `claude_prompt_context` MCP tools. Task memory now enters through
  `task_prepare` / `task_answer`; checkpoint and Curator tools remain lifecycle
  operations.
- Removed generic JSON `call` operations that returned memory through `read`,
  `search`, or scoped/unscoped `recall`. Direct CLI/Web inspection remains a
  human/operator management surface.
- Setup no longer installs Claude prompt hooks or the OpenCode loop guard and
  no longer accepts their CLI options. During upgrade it removes only the exact
  retired managed hook/guard; modified or ambiguous legacy identities fail
  explicitly and unrelated settings are preserved.
