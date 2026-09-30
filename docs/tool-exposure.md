# Automatic native tool exposure

`toolExposure.mode` controls only which Kiokuko-owned definitions appear in native model requests. The default is `auto`. On verified OpenAI API Responses or Chat Completions routes, normal chat, research, analysis, writing and review omit the nine Kiokuko model tools. Normal build, debug and devops use lean descriptions with the current phase and `nextAction` policy. An active Enno selection takes precedence over task type and uses that same policy. Native and external tools remain available. Configure explicitly with:

```yaml
config:
  toolExposure:
    mode: auto
```

`full` explicitly preserves the surface for debugging and compatibility checks. Explicit `phase` and `lean` retain their previous behavior; existing explicit settings are not migrated. Unknown task/state, unsupported provider routes and uncertain ownership preserve the original surface. `minimal` is an internal auto decision, not a configuration value. The host still finalizes memory and completion when model tools are omitted.

`phase` filters the final `PromptAssembly.tools` array after native DSH assembly. It uses the same state-denial helper as the execution policy, including phase, `nextAction` exceptions, and the active WorkUnit lease. A definition is eligible for removal only when its name is in the Kiokuko model-facing set and the native registry resolves the exact registered `execute` function. The projection never adds or rewrites a definition; it preserves the order and object references of every retained definition. Capability catalogs and the host execution guard are unchanged. This is a request-size optimization, not an authorization boundary.

Unknown state, mismatched ownership, unsupported tool-registry APIs, missing assembly tools, child or unbound agents, and non-native presentation leave the surface unchanged. PTC and `both` presentations expose `run_code`; they are intentionally excluded. A bounded warning reports each fallback reason once per adapter. Semantic-compaction observation records the final post-projection surface so it matches the request.

The native integration test drives the pinned DSH loop into the OpenAI Responses serializer with a local fake HTTP response. Its report includes runtime version, mode, tool names, and serialized system/tools/messages/request byte counts. The fake endpoint returns HTTP 400 after capture: these measurements do not claim provider success, token usage, or that schema bytes equal model-token savings. Re-run the test whenever the pinned DSH runtime or serializer changes.
