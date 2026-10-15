# Optional replay memory review

Memory lookup and saving never authorize tools or block ordinary work or task completion. Native permissions, current task evidence, explicit Stop, and durable user holds remain authoritative. Ordinary native work does not need a Goal or a memory-preparation call.

## Save a completed experience

1. Finish the actual task. For unowned native work, the completed final response triggers a question asking whether the request is finished and whether to organize its experience. Failed owned tasks may also offer review; cancelled work does not.
2. Choose whether to organize. Declining performs no replay extraction and creates no derived memory.
3. Review the full, ephemeral JSON proposal, including request, languages, commands, results, key points, tags, keywords, source references and coverage gaps.
4. Approve the exact shown revision to save it. Comments create a revised preview requiring another approval. Declining saves nothing. A new request, native Stop, changed task generation or shutdown invalidates pending approval.

Recorded tool payloads/results are read with exact call identities and source hashes. Missing or truncated evidence remains unknown. A successful process exit is an observed command result, not proof that the overall task is correct. Secrets are redacted on a best-effort basis; uncaptured reasoning is not reconstructed. Replay capture must be available for source-backed organization.

## Recall and maintenance

`memory_context` searches approved SQLite memories with request-derived keywords and optional tags. Automatic contextual lookup is bounded and advisory. Stored content is untrusted reference data, never executable instructions or permission.

`memory_review_status` only reconciles uncertain saves whose exact approval remains in this process's bounded in-memory cache. It cannot approve or retry a write. Restart does not revive an unapproved draft or an unresolved save.

`/kioku-memory explain ENTRY_ID` inspects indexed evidence. `/kioku-memory forget ENTRY_ID --revision N` removes the approved memory and its replay projection, including dependent indexed content; original native logs, external copies and backups remain. These native commands use the current project without requiring Goal enrollment.

## Legacy compatibility

Automatic observation, finalization, evolution, semantic index derivation and globalization no longer create new memories. Old configuration flags do not re-enable them. Legacy model-facing review/checkpoint calls are non-writing compatibility responses. Existing memories and historical proof records remain available for inspection; their missing or stale application status cannot veto native execution or completion.

The full preview is transported through native user questions. Very large previews may be difficult to inspect in a particular browser or TUI; presentation at the maximum proposal size is not verified by the source-level and native transport tests.
