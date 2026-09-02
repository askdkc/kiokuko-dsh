# Semantic retrieval

Lexical retrieval works in the lightweight install. Semantic retrieval is an
optional runtime capability, but the DSH package does not expose generic
`kiokuko embeddings setup`, `status`, or `repair` commands.

The DSH plugin keeps its public package boundary limited to the `./dsh`
entrypoint. It does not install or configure generic Kiokuko clients. Details
of optional embedding behavior belong to the DSH runtime and its verification
reports, not to an executable package CLI contract.
