# Security and trust

## Memory and secrets

Kiokuko refuses content that resembles passwords, API keys, tokens, private keys,
or similar secrets. It does not store full conversations. Memory is advisory and
must not override current code, configuration, or execution evidence.

## External Skills

External Skill discovery is reference-only. Kiokuko verifies a source commit, stores
bounded content as an untrusted candidate, and never installs, runs, or registers
fetched Skill content automatically. `official` is the default discovery mode;
`community` is explicit opt-in and `off` disables discovery.

Inspect or manage mappings with:

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable <skill-id>
kiokuko skills refresh <skill-id>
```

The Web UI can inspect and disable mappings, but has no install, script, or MCP
registration action.

## MCP extensions and public errors

Codex `ToolLifecycleContributor` and other client extensions can inspect or replace successful and error MCP results. They are
therefore part of the trusted computing base; Kiokuko cannot claim end-to-end
authenticity without an extension-unforgeable original-result identifier and modified
flag. Do not combine Kiokuko with an extension that changes critical results.

Normal public tool failures use `isError: true` with an allowlisted message plus
`structuredContent.code` and `structuredContent.retryable`; only `BACKPRESSURE` may
include bounded `retryAfterSeconds`. Raw stacks, SQL, paths, payloads, and secrets
are not copied into generic errors. Specialized validation and recovery errors retain
only their bounded purpose-specific fields.
