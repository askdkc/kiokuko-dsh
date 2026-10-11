# Vendored dsh-auth source

Source: https://github.com/askdkc/dsh-cli/tree/348082d873f563ed76ec7a70f2ff717038d5fe70/dsh-auth
Revision: `348082d873f563ed76ec7a70f2ff717038d5fe70`.
License: MIT, reproduced in [dsh-auth-LICENSE.txt](dsh-auth-LICENSE.txt).

`src/dsh/models/vendor/` contains the required credential persistence, authentication
contracts, Pi catalog bridge, Nous OAuth flow, cancellation helpers and OpenCode
catalog/transport/codec/replay/SDK adapter sources. The upstream command and UI services
are excluded: Kiokuko owns its Web management service and does not register TUI `/auth`.

Local changes: relative imports target the vendored directory; Nous depends on the
structural AuthInteraction interface; optional properties use conditional spreads for
Kiokuko's exactOptionalPropertyTypes; catalog optional state types are explicit.
Credential JSON parse diagnostics omit underlying content to avoid secret disclosure.
The canonical storage format/path/keys, file lock, atomic write, permissions and OAuth
refresh behavior are retained. No pre-existing credential migration is performed.

The SDK transport is bundled by `scripts/build-model-transports.mjs` from the pinned
AI SDK development dependencies. Each bundled dependency's license is collected in
`dist/dsh/models/vendor/THIRD_PARTY_NOTICES.txt` and shipped in full/modular packages.
Native DSH/Pi libraries remain host dependencies and are used through their public APIs.

Kiokuko's non-vendored service adds profile settings, route identity mapping, human Web
operations, lifecycle cancellation, immutable prepared adapters and Infron tier hooks.
