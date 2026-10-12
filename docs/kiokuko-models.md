# Kiokuko Models

In the Web profile, open **Settings → Kiokuko Models**, or enter exactly
`/kiokuko model` in a chat. The host executes this command without a model request.
Both entry points use the same panel, including before a native provider is configured.

Choose a provider under **Add connection** and paste its API key: **Save and connect**
stores the connection and the key together, then asks the adapter which models the
connection serves. Pressing Enter in the key field runs the same action. OAuth
providers also offer **Log in**, which shows the authentication link, device code or
manual prompt and a cancellation button in the same panel. Authentication errors
require an explicit retry; closing the panel cancels a pending login. **Log out** also
signs the shared credential out of dsh-cli.

Connection name, Base URL, protocol, service tier, **Save connection**, **Refresh models**,
**Log out** and manual model registration live under **Advanced settings**. Discovery
that fails still leaves the connection and key stored, reports the cause and keeps
manual registration available. A model whose endpoint and catalog both withhold
capacities is stored with the adapter's profile defaults (`defaultContextWindow` 262144,
`defaultMaxTokens` 32768) so a listing that names ids only still yields usable models.

Supported connections: OpenAI API, Codex, Claude, xAI, DeepSeek, OpenCode Zen/Go,
OpenRouter, Nous/Hermes, Infron, Ollama and custom connections. OAuth availability
comes from the installed provider implementation; unsupported flows are not invented.
Ollama needs no key. Custom connections explicitly select Chat Completions, Responses
or Messages. Use HTTPS, or HTTP on loopback for a local server. For Messages,
an origin or API prefix ending in `/v1` is accepted; the SDK adds `/v1/messages`
once, preserving any preceding path prefix.

**Refresh models** re-imports the models an endpoint serves. If discovery fails or
returns nothing usable, register the exact model ID and limits manually under
**Advanced settings → Register model manually**, then **Save connection**. Search the
resulting list. **Use in current chat** only changes that idle chat; **Default for new
chats** saves the native default for future chats. Enno, Deep and model-auto use the
same registered adapters and model capabilities. An unavailable model is rejected
rather than silently substituted.

Managed provider requests also enforce the output-token budget at dispatch,
including bare adapter calls. A request never exceeds 32,768 output tokens, the
prepared model output limit, or its context limit; a smaller explicit caller
budget is preserved. Invalid caller budgets are rejected before transmission.
Catalog/context capacity metadata is not rewritten by this request-level clamp.

## GPT-6.1-Sol head with DeepSeek V4.1 Flash workers

The **Head/worker pair (optional)** section offers the opt-in pair in the same
Settings panel. Select the exact configured head and worker connections, then save
for the current idle chat or as the default for new chats. Multiple connections
remain separate choices, even when their display names match. Cancel does not
change a saved choice. Disabling the pair restores native model selection; saving
a different normal head model also leaves pair mode for the selected scope. Selecting
the exact same provider and head model preserves the worker choice. Profile defaults are
snapshotted per chat, so changing the default does not rewrite existing chats.

The execution-choice card also offers the pair for just the current normal task,
and Enno's model-configuration menu offers the same pair. Lisp is an execution-tool
choice and uses the normal parent/worker routing. In Enno, `ideal`, `zenki`, `goki`
and `check` use the head; the delegated `worker` uses Flash. A profile/chat pair
seeds the initial Enno role review. An already approved Enno task keeps its explicit
role configuration until the next task; selecting another Enno custom configuration
continues to work.

Selection and dispatch require the exact live catalog bindings. The head ID is
`gpt-6.1-sol`. The worker ID is `deepseek-flash` on a DeepSeek route,
`deepseek-v4.1-flash` on OpenCode Zen/Go, or `deepseek/deepseek-v4.1-flash` on
OpenRouter. A bundled catalog is not proof of account access. Missing models,
credentials or compatible connections produce an unavailable reason; there is no
fallback to a different model or provider and no automatic login/download.

Native `subagent` (spawn) and `subagent_fork` requests receive the selected worker
model while the parent retains the head. The preset does not trigger delegation,
add tools, change approval/sandbox policy, change depth/concurrency limits, or
apply to Deep Planning. Child routes have durable identity-bound receipts and are
revalidated against their current owner and selection before further requests.
Local scripted-provider tests verify routing and persistence, not real-provider
availability, billing or answer quality.

## Infron

The default endpoint is `https://llm.onerouter.pro/v1`, using Chat Completions.
Select **Service tier → Standard / Flex**; the default is Standard. Kiokuko sends
`provider: {service_tier: "standard" | "flex"}` at the top level of the request body.
It never sends an `extra_body` wrapper, changes tier on a failed request, or adds this
field to other providers. A prepared request keeps its tier through retries even if
settings change. The panel distinguishes the next requested tier from the last
request and its reported served tier. Missing response metadata means **unknown**;
Flex can be served as Standard by Infron.

## Storage and permissions

Non-secret connection settings live in `kiokuko-models.json` under the active profile
directory. Changes use a revision check, a file lock and atomic replacement. Credentials
share dsh-auth's `$DSH_HOME/dsh-auth/credentials.json` location (normally
`~/.dsh/dsh-auth/credentials.json`, with the existing `DSH_AUTH_CREDENTIALS` override), provider keys and format. Credentials are written with
mode 0600, using the vendored lock and atomic-update implementation. Shared OAuth refresh
is serialized. Existing credentials and native profile settings are never migrated or deleted.

The Web transport's authentication protects management requests. Secret operations use
JSON POST requests and reject cross-site browser requests. Keys and refresh tokens never
appear in list responses, normal profile settings or command history. The settings panel
necessarily grants access to the shared credentials through login, replacement and logout.
Session tool permissions do not govern these explicit human settings operations.

OrcaRouter is no longer offered or recommended. Legacy saved Enno/Deep configurations
remain readable and require explicit model reselection before reuse. Replay history and
migrations are unaffected.

## Verification

After `npm run build`, `node scripts/verify-head-worker-settings-web.mjs` exercises
the pair controls in a disposable native Web profile with localhost-only fixtures,
including default/current scopes, Cancel, unavailable models and restart.
`PLAYWRIGHT_EXECUTABLE_PATH` may select an installed browser. This check requires
Chromium socket access; a blocked browser launch is not a passed UI test.


`npm run test:models:web` installs the packed package in a disposable Web profile,
uses a local provider and tests Settings, commands, the add-provider-and-key action,
a listing that discloses no capacities, a refused save that must keep the typed key,
authentication cancellation, selection, reload/restart and the native tool loop. Unit
tests drive the discovery contract through a stub runtime and send actual Pi adapter
requests to a local server. Real account OAuth completion and live Infron generation
are separate acceptance gates; local fixtures do not establish either.

[Vendored auth provenance and changes](dsh-auth-provenance.md).
