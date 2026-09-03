# Security and trust

Kiokuko for DSH treats host identity and model content as separate planes.
The DSH host owns run routing and credentials; model-visible tools expose only
semantic report fields. See [the security boundary](security.md) for the exact
fail-closed rules.

Retrieved memory, external Skill descriptions, and advisory contributions are
untrusted context. Bundled Skill manifests are verified before exposure. Secret
material is rejected or redacted before durable ledger storage.
