# Provider authentication boundaries

Model inventory is metadata, not permission to authenticate a provider. The Web
Models page inventories its saved connections from immutable profile/catalog
metadata. It must not discover every native provider or invoke an adapter's
credential-resolving `listModels` just to show that inventory. Validation of an
existing head/worker pair lists only those two selected providers. Current model
selection validates its call configuration once, in the Models service.

The legacy Models transport still accepts an explicitly injected `CredentialFile`
and owns OAuth/API-key transport authentication. Read-only listing must never
refresh OAuth or acquire its mutation lock. Explicit Nous refresh uses the plugin
lifetime signal and rejects redirects; cancellation must not publish a replacement
credential. These changes do not establish the cause or resolution of DeepSeek
Platform profile/balance failures.

## Remaining host integration constraint

The installed public `dshAuth.api` contract exposes masked `providers`, `login`,
`logout`, optional `catalogStatus`/`refreshModels`, and credential-change callbacks.
It does not expose credentials, the configured credential-store identity, or an
authenticated adapter/transport for a connection. The Web Models implementation
still constructs its legacy credential store; that responsibility has **not** been
migrated by this fix.

Delegating login/logout alone while retaining a guessed file path would still
allow the two consumers to address different stores. Replacing an owned connection
with a native provider also needs a supported mapping for its endpoint, protocol,
model options and retained session identity. Do not obtain secrets through private
service fields, assume the default file is the host's store, silently change saved
routes, or weaken prepared-call ownership to work around this constraint.

A complete migration requires an existing host-owned injectable credential or
authenticated-transport boundary, or a separately approved change to the deployment
contract. DSH itself is outside this repair's authorized scope. Until that boundary
is available, do not claim that Web authentication uses the host's configured store
or that all authentication management is delegated to `dshAuth`.
