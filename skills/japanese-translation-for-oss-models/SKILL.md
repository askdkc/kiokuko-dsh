---
name: natural-japanese-output
description: Write Japanese that reads as if it was originally Japanese. Use when the user writes in Japanese or requests Japanese output.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: natural-japanese-output -->

# Natural Japanese Output

## Purpose

Produce Japanese that reads as if it was originally written in Japanese, even
when the model reasons, plans, or represents concepts more effectively in
English.

The pipeline is: understand the meaning → discard the source-language sentence
structure → reconstruct with natural Japanese information flow → remove
translation smell before answering. Never translate sentence by sentence;
translate the meaning, then write the answer again.

Success criterion: a native Japanese reader should not feel that the answer was
translated from English.

Scope: these rules govern wording, not block order. When a response must follow
a fixed schema, a required report section, or an established heading order, that
structure outranks the sentence-level preferences below — apply them inside each
block instead of reordering the blocks. If it is unclear whether a rule is about
wording or structure, treat it as wording-only.

## Core policy

You may reason internally in any language. The final answer must not preserve:

- English word order
- English pronoun frequency
- English connective frequency
- English nominalization patterns
- English sentence boundaries
- English rhetorical structure

Do not:

> この設計は複数の利点を提供します。第一に、それは依存関係を明確にします。第二に、それはテスト可能性を改善します。

Prefer:

> この設計には主に二つの利点がある。依存関係が明確になり、テストもしやすくなる。

## Reconstruction rules

### Omit subjects Japanese does not need

Do not:

> Laravel はリクエストを受け取ります。Laravel はルートを解決します。その後 Laravel はコントローラを実行します。

Prefer:

> Laravel がリクエストを受け取ると、ルートを解決し、その後コントローラを実行する。

Keep the subject when omitting it would make the actor ambiguous.

### Do not copy English pronoun behavior

Avoid mechanically translating *it*, *this*, *that*, *they*, *these*, *those*.

Do not: この関数はキャッシュを作成します。それは60秒後に失効します。
Prefer: この関数で作成したキャッシュは60秒後に失効する。

If a pronoun is unnecessary in Japanese, remove it or merge the sentences.

### Lead with the conclusion

For technical and analytical answers, order the content as conclusion, reason,
conditions or exceptions, details, then action or implementation. Do not delay
the main answer because English exposition builds toward it.

Do not: Node.js のイベントループにはさまざまな特性があります。これらを考慮すると、今回のケースでは worker_threads を使用することが適切です。
Prefer: 今回は `worker_threads` を使うのが適切。Node.js のイベントループだけでは CPU バウンド処理を並列化できないためだ。

### Reduce explicit connectives

Do not mechanically translate *However*, *Therefore*, *Additionally*,
*Furthermore*, *Meanwhile*, *On the other hand*, *In other words*, *As a
result*, or *From this perspective*. Japanese usually carries these relations in
sentence order, particles, or verb forms; use a connective only when it improves
clarity.

Do not: しかしながら、この方法には問題があります。加えて、パフォーマンスも低下します。
Prefer: ただし、この方法には問題があり、パフォーマンスも落ちる。 / この方法には問題がある。パフォーマンスも落ちる。

### Prefer verbs over translated nominalizations

implementation → 実装する, improvement → 改善する, execution → 実行する,
verification → 確認する, modification → 変更する, optimization → 最適化する.
Do not turn every English noun into a Japanese noun phrase.

Do not: 設定の変更を実行することで問題の解決を行えます。 / パフォーマンスの改善を実現します。
Prefer: 設定を変えれば解決できる。 / パフォーマンスが改善する。

### Use potential forms instead of ことができます

Prefer 使える, 確認できる, 作れる, 避けられる, 減らせる. Use
`〜することができます` only when the formal register genuinely requires it.

Do not: このコマンドを使用することでログを確認することができます。
Prefer: このコマンドでログを確認できる。

### Use という only to define or quote

Do not: race condition という問題が発生する可能性があります。
Prefer: race condition が発生する可能性がある。

Appropriate: 「race condition」とは、実行順序によって結果が変わる競合状態を指す。

### Drop translated bureaucratic phrasing

Prefer the plain form: `〜において` → 〜では, `〜に関して` → 〜について,
`〜の観点から` → 〜では, `〜となります` / `〜になります` → 〜です, `〜を提供します`
→ 〜がある / 〜を使える, `〜を可能にします` → 〜できるようにする,
`〜の実装を行います` → 〜を実装する, `〜の改善を行います` → 〜を改善する,
`〜を実行します` → 〜する, `〜をサポートします` → 対応する.

Do not: Laravel において、この設定に関して変更が必要です。 / 原因は設定ファイルの競合となります。 / こちらが設定ファイルになります。
Prefer: Laravel では、この設定を変更する必要がある。 / 原因は設定ファイルの競合です。 / これが設定ファイルです。

## Translation smell check

Inspect the draft for these. They are warning signs, not forbidden strings.

| Suspicious | Prefer |
|---|---|
| 〜することができます | 〜できる |
| 〜することが重要です | 〜が重要 / 〜した方がよい |
| 〜ということを意味します | つまり〜 / 〜を意味する |
| 〜であるという事実 | 〜であること |
| これは〜です / それは〜です | omit, or name the referent |
| 〜の観点から / 〜に関して / 〜において | 〜では / 〜について |
| しかしながら / 加えて / 結果として | ただし / さらに / そのため, or omit |
| 〜を提供します / 〜を可能にします | 〜がある / 〜できるようにする |
| これはあなたにより良い制御を与えます | より細かく制御できる |
| ここで重要なことは、〜ということです | 重要なのは、〜という点だ |
| 〜ということは注目に値します | なお、〜 / 注意点として、〜 |

## Technical Japanese

### Keep established terminology

Keeping a standard term in English is usually more precise than a forced
translation: event loop, race condition, deadlock, cache, middleware, hook,
callback, worker, thread, process, transaction, migration, schema, plugin,
lifecycle, dependency injection, lock, timeout, retry, commit, rollback.

Established Japanese equivalents are clearer for: dependency → 依存関係,
concurrency → 並行性, parallelism → 並列性, consistency → 一貫性,
availability → 可用性.

Accuracy outranks forced localization.

### Never translate code identifiers

Function names, variable names, configuration keys, CLI flags, API names, class
names, file names, and protocol names stay exactly as written:

> `max_threads` を増やしても、`max_concurrent_threads_per_session` が 3 のままなら、単一セッションでは最大3スレッドしか動かない。

### Keep bilingual pairs in sync

For a file that exists in two languages — a translation produced beside its
source, such as `README.md` and `README.ja.md` — mirror the source structure
rather than re-authoring it. This is the one place where reconstructing the
sentence flow does not extend to reordering the document.

- Keep the same sections, in the same order, and the same headings. Do not add,
  merge, split, or drop a section because the Japanese reads better that way.
- Keep code blocks, commands, paths, configuration keys, and identifiers
  byte-identical; translate only the prose around them.
- Do not add explanations, caveats, or examples the source does not contain.
- When the source changes, update the pair in the same change rather than
  leaving the two versions describing different behavior.

## Precision

### Preserve modality

Do not flatten these distinctions: must → 必須 / 〜しなければならない, need to →
〜する必要がある, should → 〜した方がよい / 〜すべき, recommended → 推奨,
optional → 任意, likely → 可能性が高い, possible → 可能性がある, uncertain →
断定できない.

Do not weaken facts into vague language, and do not strengthen guesses into
facts.

### Replace vague adjectives with concrete effects

Avoid unsupported 良い, 強力, 高性能, 柔軟, 効率的. Explain the mechanism.

Do not: この方式の方が効率的です。
Prefer: この方式ならプロセス生成が不要なので、短時間のタスクでは起動コストを抑えられる。

## Register

**Technical / analytical** (software, systems, APIs, infrastructure,
architecture, benchmarks, debugging, scientific topics): lead with the answer,
prefer concise plain Japanese, preserve technical terms, state trade-offs
explicitly, and separate fact, inference, recommendation, and uncertainty.

> その設計だと競合する。`foo()` と `bar()` が同じ状態を非同期に更新しており、lock も transaction もないためだ。

**General explanation:** clear, natural Japanese; do not make it unnecessarily
formal.

> 原因はキャッシュです。古い結果が60秒残る設定なので、その間は更新しても画面に反映されません。

**Creative / social / conversational:** follow the requested tone and do not
sanitize the text into generic assistant prose. Preserve rhythm, intentional
fragments, slang, jokes, sharpness, and character voice. Remove translation
artifacts only, unless broader rewriting is requested.

## Self-check

Before sending any Japanese answer:

1. **Meaning** — Did I answer the actual question? Is the conclusion correct?
   Are facts and guesses separated? Are important technical distinctions
   preserved?
2. **De-translate** — If this draft had originally been written in English, can I
   still see the English sentence skeleton? If yes, rewrite it. Look for
   repeated subjects and pronouns, explicit connectives, nominalizations,
   `ことができます`, `ということ`, `において`, `に関して`, `観点から`, `提供する`,
   `可能にする`.
3. **Rhythm** — Are sentence endings repeating unnaturally, or too many `です。`
   endings? Are clauses too long? Are particles awkward? Can two
   translated-looking sentences merge, should one long English-style sentence
   split, and is the subject omitted where Japanese would normally omit it?
4. **Native-reader test** — Would a technically literate native Japanese speaker
   plausibly write this exact sentence? Grammatical validity is insufficient;
   the target is idiomatic Japanese.

## Final rule

Do not translate English wording. Translate the intended meaning, then write the
answer again in Japanese. The final response should feel authored in Japanese
even when the model's internal reasoning is English-dominant.
