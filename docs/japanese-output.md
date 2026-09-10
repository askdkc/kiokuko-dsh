# Japanese output guidance

Kiokuko automatically includes the complete bundled
[Natural Japanese Output Skill](../skills/japanese-translation-for-oss-models/SKILL.md)
in native Agent prompts for DeepSeek, Kimi, GLM, Qwen, HY/Hunyuan, MiMo and
MiniMax model families. This covers ordinary work, Enno roles and Deep workers.
No additional configuration or Skill tool permission is needed.

The exact selected **model ID** determines the match, after host routing.
Matching is case-insensitive and accepts model namespaces, version numbers
and local quantization suffixes. Connection names and display labels do not
determine model identity. Opaque custom model aliases without a recognizable
family name cannot be detected automatically.

The Skill retains its file's declared name, `natural-japanese-output`, and is
also available from the bundled Skill provider for explicit use. Its contents
are loaded verbatim; the original file is not rewritten.

For matching models, the guidance is present once in the active system prompt.
It applies when handling Japanese input or producing requested Japanese output.
An explicit language request takes precedence. Code identifiers, literal
quotations, evidence references and machine-readable protocol values must remain
unchanged. For JSON responses, the guidance applies only to human-readable
Japanese string values; the required schema remains authoritative.

The host does not translate the user's message, ask the model for a reasoning
transcript, or make an extra translation call. Keeping the guidance present for
the selected family avoids guessing Japanese from isolated kanji or tool
results. It adds the Skill's text to the prompt even on English turns; its
application remains conditional on the requested language. The local file is
cached once per process. Provider prompt caching is not guaranteed.

The normal native prompt/log pipeline carries the content. Deep's existing
request accounting includes the additional bytes. Changing to an unrelated
model removes the automatic section from its active prompt. Native complete
prompt overrides and direct auxiliary LLM calls retain their own contracts.

## Verification

Tests check family matching and false positives, exact file delivery, prompt
deduplication, caller immutability, model switching, bundled Skill retrieval,
native provider-visible prompts and Deep budget reservations. The recording
adapter tests establish delivery and integration, not improvements in a live
model's Japanese quality.

Function contracts follow `code.domain.v1` for model-family classification,
`code.boundary.v1` for bundled identity and prompt ownership, and
`code.verification.v1` for native request and package evidence.
