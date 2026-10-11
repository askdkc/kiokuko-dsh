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

`npm run test:models:web` installs the packed package in a disposable Web profile,
uses a local provider and tests Settings, commands, the add-provider-and-key action,
a listing that discloses no capacities, a refused save that must keep the typed key,
authentication cancellation, selection, reload/restart and the native tool loop. Unit
tests drive the discovery contract through a stub runtime and send actual Pi adapter
requests to a local server. Real account OAuth completion and live Infron generation
are separate acceptance gates; local fixtures do not establish either.

[Vendored auth provenance and changes](dsh-auth-provenance.md).
