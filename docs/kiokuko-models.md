# Kiokuko Models

In the Web profile, open **Settings → Kiokuko Models**, or enter exactly
`/kiokuko model` in a chat. The host executes this command without a model request.
Both entry points use the same panel, including before a native provider is configured.

Choose a provider, save the connection, then enter an API key in the masked field
or choose **Log in** where OAuth is supported by the installed adapter. The browser
shows the authentication link, device code or manual prompt and a cancellation button.
Authentication errors require an explicit retry; closing the panel cancels pending login.
**Log out** also signs the shared credential out of dsh-cli.

Supported connections: OpenAI API, Codex, Claude, xAI, DeepSeek, OpenCode Zen/Go,
OpenRouter, Nous/Hermes, Infron, Ollama and custom connections. OAuth availability
comes from the installed provider implementation; unsupported flows are not invented.
Ollama needs no key. Custom connections explicitly select Chat Completions, Responses
or Messages. Use HTTPS, or HTTP on loopback for a local server. For Messages,
an origin or API prefix ending in `/v1` is accepted; the SDK adds `/v1/messages`
once, preserving any preceding path prefix.

**Refresh models** imports models with known context and output limits. If discovery
fails or returns no limits, register the exact model ID and limits manually, then
save the connection. Search the resulting list. **Use in current chat** only changes
that idle chat; **Default for new chats** saves the native default for future chats.
Enno, Deep and model-auto use the same registered adapters and model capabilities.
An unavailable model is rejected rather than silently substituted.

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
uses a local provider and tests Settings, commands, authentication cancellation,
selection, reload/restart and the native tool loop. Unit tests send actual Pi adapter
requests to a local server. Real account OAuth completion and live Infron generation
are separate acceptance gates; local fixtures do not establish either.

[Vendored auth provenance and changes](dsh-auth-provenance.md).
