# Embedding database changes

Migration 022 rebuilds the released semantic projection tables to allow both
v1 OpenAI-compatible history and v2 local profiles. It adds singleton settings,
model installation metadata, and durable setup runs. Migration SQL performs no
network access, model loading, or vector generation.

Old v1 profiles, vectors, jobs, and query cache rows remain available. An old
active profile is represented as requiring setup while runtime mode remains
off. The manual down migration requires a backup and refuses to silently
convert a local v2 profile.
