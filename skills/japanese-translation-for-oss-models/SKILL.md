---
name: natural-japanese-output
description: Write Japanese that reads as if it was originally Japanese. Use when the user writes in Japanese or requests Japanese output.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: natural-japanese-output -->

<!-- kiokuko:runtime contract -->
# Natural Japanese Output

Write Japanese as Japanese: understand the meaning, discard the source-language syntax, reconstruct natural information flow, then check the result. Do not translate sentence by sentence. Internal reasoning may use any language; do not expose a reasoning transcript.

## Meaning and structure

Preserve facts, uncertainty, conditions and modality: must/need to/should/recommended/optional/likely/possible/uncertain are distinct. Do not weaken requirements, overstate evidence, or turn speculation into fact. Technical answers lead with the conclusion, then reasons, conditions and useful details.

Required schemas and block order take precedence. Apply style within the blocks; do not reorder a mandated structure. Explicit output-language requests take precedence over the input language. Preserve code identifiers, literal quotations, evidence references and machine-readable values; in JSON, apply this guidance only to human-readable Japanese strings.

Bilingual companion files must mirror the source's sections and order. Keep code blocks, commands, paths, configuration keys and identifiers byte-identical. Translate prose only; do not add examples, merge sections or insert explanations absent from the source. Update both files together.

## Natural wording

- Omit unnecessary subjects, repeated names and English-style pronouns; name the referent when omission would make the actor ambiguous.
- Rebuild English word order, sentence boundaries, rhetoric and connective frequency. Merge related thoughts where natural; use ただし or そのため only when the connection needs stating.
- Prefer verbs and potential forms: 実装する、改善する、確認できる. Avoid bureaucratic nominalizations such as 実装を行う and repeated ことができます.
- Use という for definitions or quotations, not as filler. Prefer では／について／です over において／に関して／となります.
- Replace unsupported 良い、強力、高性能、柔軟、効率的 with the concrete effect or mechanism.
- Keep established technical terms when precise (event loop, race condition, worker, transaction, schema, retry). Prefer standard Japanese equivalents such as 依存関係、並行性、並列性、一貫性、可用性. Accuracy outranks forced localization.
- Never translate names such as `max_threads` or change numerical limits and syntax.

Useful reconstructions:
「Laravelはリクエストを受け取ります。Laravelはルートを解決します。」→「Laravelがリクエストを受け取ると、ルートを解決する。」
「それは60秒後に失効します」→「このキャッシュは60秒後に失効する。」
「この方式は効率的です」→「この方式ならプロセス生成が不要なので、起動コストを抑えられる。」

Warning signs, not forbidden strings: 〜ということを意味します、〜であるという事実、これは〜です、しかしながら、加えて、〜の観点から、〜を提供します、〜を可能にします、〜することが重要です. Use a shorter concrete expression when it carries the same meaning.

## Register and final check

Technical analysis: concise, plain Japanese; separate facts, inference, recommendations and uncertainty; state relevant trade-offs. General explanations: clear and natural, without unnecessary formality. Creative/social writing: preserve the requested voice, rhythm, humor, slang and emotional force; do not sanitize it.

Before sending, check:
1. Did the answer address the actual question and preserve facts, modality and technical distinctions?
2. Does English sentence structure still show through? Rewrite the meaning rather than translating the wording.
3. Are subjects, connectives and sentence endings needlessly repeated? Split cumbersome clauses or merge closely related sentences.
4. Would a technically literate native speaker naturally write this? Grammatical correctness alone is insufficient.
<!-- /kiokuko:runtime -->

<!-- kiokuko:documentation examples -->
## Further wording examples

These examples illustrate the runtime rules; they add no requirements.

| Stiff or translated phrasing | Natural phrasing |
| --- | --- |
| 設定の変更を実行することで問題の解決を行えます。 | 設定を変えれば解決できる。 |
| このコマンドを使用することでログを確認することができます。 | このコマンドでログを確認できる。 |
| Laravelにおいて、この設定に関して変更が必要です。 | Laravelでは、この設定を変更する必要がある。 |
| この方式は複数の利点を提供します。第一に、それは依存関係を明確にします。 | この方式には主に二つの利点がある。依存関係が明確になり、テストもしやすくなる。 |

Keep technical distinctions even when simplifying the wording: 「必須」と「推奨」、
「確認済み」と「可能性がある」は別の意味を持つ。
<!-- /kiokuko:documentation -->
