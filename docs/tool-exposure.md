# Automatic native tool exposure

`toolExposure.mode` controls only which Kiokuko-owned definitions appear in native model requests. The default is `auto`. On all DSH native provider connections, normal chat, research, analysis, writing and review omit the nine Kiokuko model tools. Normal build, debug and devops use lean descriptions with the current phase and `nextAction` policy. An active Enno selection takes precedence over task type and uses that same policy. Native and external tools remain available. Configure explicitly with:

```yaml
config:
  toolExposure:
    mode: auto
```

`full` explicitly preserves the surface for debugging and compatibility checks. Explicit `phase` and `lean` retain their previous behavior; existing explicit settings are not migrated. Unknown task/state and uncertain ownership preserve the original surface. Omitting the setting uses `auto` as of v0.1.89; no database, session or configuration migration is needed. `minimal` is an internal auto decision, not a configuration value. The host still finalizes memory and completion when model tools are omitted.

`phase` filters the final `PromptAssembly.tools` array after native DSH assembly. It uses the same state-denial helper as the execution policy, including phase, `nextAction` exceptions, and the active WorkUnit lease. A definition is eligible for removal only when its name is in the Kiokuko model-facing set and the native registry resolves the exact registered `execute` function. The projection never adds or rewrites a definition; it preserves the order and object references of every retained definition. Capability catalogs and the host execution guard are unchanged. This is a request-size optimization, not an authorization boundary.

Unknown state, mismatched ownership, unsupported tool-registry APIs, missing assembly tools, child or unbound agents, and non-native presentation leave the surface unchanged. PTC and `both` presentations expose `run_code`; they are intentionally excluded. A bounded warning reports each fallback reason once per adapter. Semantic-compaction observation records the final post-projection surface so it matches the request.

The native integration test drives the pinned DSH loop through the pi-ai Responses, Chat Completions and Anthropic Messages serializers and the official DeepSeek Messages adapter: `openai-responses` (`/v1/responses`, flat tool definitions and `input`) and `openai-completions` (`/v1/chat/completions`, nested `tools[].function` definitions and `messages`), and Messages (`tools[].input_schema`, `tool_use` and `tool_result`). Settings metadata deliberately fails in this fixture; the exact DeepSeek and unknown provider bindings still optimize. Messages cases preserve thinking text and signatures across tool-result replay. The same suite accepts `KIOKUKO_TOOL_EXPOSURE_ENTRY` to load a packed public DSH entry. Fetch is intercepted locally and unexpected URLs fail; no real provider request is made. Protocol cases run serially and restore fetch and plugin state after each case.

With the current `0.2.0-rc.2` fixture, each protocol covers explicit `full`, `phase` and `lean`, all eight task types under default `auto`, and explicit `full` on research. It compares every retained native/external definition, including schemas and relative order, against the same protocol's full surface, and checks that projection leaves registered schemas unchanged. Research under auto executes the fixture external tool, serializes its result with the matching call ID, keeps Kiokuko tools omitted in the next request, and reaches the final assistant answer. Explicit lean also exercises that roundtrip. The legacy `0.1.5-rc.1` fixture covers Responses and Chat Completions full/phase only; current-only assertions are gated, not reported as legacy auto/lean coverage.

`TOOL_EXPOSURE_WIRE_REPORT` includes runtime and protocol, full/phase/lean measurements, and auto rows identified by task type, requested/effective mode, Kiokuko tool names, total tool count and serialized tool bytes. It also records request and message bytes: Responses uses `input` and separately measures `instructions`; Chat Completions uses `messages` (including system/developer messages), with the system/developer subset measured separately. Messages measures its top-level `system` separately from `messages`. These fields overlap for Chat Completions and must not be added together. Tool-byte and body-byte savings compare the same build task and input for full/phase/lean. Only tool-byte savings isolate the tool definitions; per-session request metadata may also affect body differences. Different auto tasks are not paired body-savings baselines.

Capture-only cases return intentional HTTP 400 after recording. Successful synthetic SSE responses prove external tool-result roundtrips and native turn completion. These cases do not measure real provider success, token usage or cost, and fixture usage fields are not provider measurements. Serialized schema-byte reductions are not model-token savings. Re-run the test whenever the pinned DSH runtime or serializer changes.

Run mandatory current source coverage and packed coverage with the same fixture:

```sh
export KIOKUKO_DSH_PACKAGE_ROOT="$PWD/tests/fixtures/dsh-runtime-current/node_modules"
export KIOKUKO_EXPECTED_DSH_VERSION=0.2.0-rc.2
export KIOKUKO_REQUIRE_DSH_NATIVE=1
npm run test:integration:tool-exposure
npm test
npm run build
npm run pack:check
```

With `KIOKUKO_REQUIRE_DSH_NATIVE=1`, `pack:check` runs the same wire suite using the extracted tarball's public DSH entry. The current CI job includes this check. Current Messages dependencies must load successfully; required protocol cases are not silently skipped.

Projection operates on DSH’s provider-neutral `PromptAssembly.tools` before adapter serialization. Provider family, API protocol, authentication and local/remote transport do not gate optimization. Missing settings metadata does not disable it. Model admission and authentication remain DSH responsibilities. The deprecated public route query retains its legacy OpenAI-only result for compatibility but is not used by native projection. Fallback warnings include the requested mode and the failed binding, state, ownership or presentation condition, once per adapter and reason.
