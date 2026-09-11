---
name: natural-japanese-output
description: >
  Improve Japanese answer quality for models whose internal reasoning,
  instruction-following, or latent representations are primarily English-oriented.
  Apply this skill whenever the user writes in Japanese or requests Japanese output.
  The model may reason internally in any language, but the final response must read
  like original Japanese, not translated English.
---

# Natural Japanese Output

## Purpose

Produce Japanese that reads as if it was originally written in Japanese.

This skill is specifically designed for models that may internally reason,
plan, or represent concepts more effectively in English, but must answer in
high-quality Japanese.

Do NOT mechanically translate English sentences into Japanese.

Instead:

1. Understand the meaning and logical structure.
2. Discard the source-language sentence structure.
3. Reconstruct the answer using natural Japanese information flow.
4. Perform a final "translation smell" check before answering.

The success criterion is simple:

> A native Japanese reader should not feel that the answer was translated from English.

---

# Core Policy

## 1. Reason for correctness, then rewrite for Japanese naturalness

You may reason internally in English if that improves correctness.

However, the final answer must NOT preserve:

- English word order
- English pronoun frequency
- English connective frequency
- English nominalization patterns
- English sentence boundaries
- English rhetorical structure

Do not translate sentence by sentence.

Translate meaning, then rewrite.

Scope: these rules govern wording, not block order. When a response must follow a
fixed schema, a required report section, or an established heading order, that
structure takes precedence over the sentence-level preferences below; apply them
inside each block instead of reordering the blocks. If you cannot tell whether a
rule applies to wording or to structure, treat it as wording-only.

Bad:

> この設計は複数の利点を提供します。第一に、それは依存関係を明確にします。第二に、それはテスト可能性を改善します。

This is structurally close to:

> This design provides several benefits. First, it clarifies dependencies. Second, it improves testability.

Better:

> この設計には主に二つの利点がある。依存関係が明確になり、テストもしやすくなる。

---

# Japanese Reconstruction Rules

## 2. Omit subjects when Japanese does not need them

English usually requires explicit subjects. Japanese often does not.

Bad:

> Laravel はリクエストを受け取ります。Laravel はルートを解決します。その後 Laravel はコントローラを実行します。

Better:

> Laravel がリクエストを受け取ると、ルートを解決し、その後コントローラを実行する。

Do not omit the subject if doing so makes the actor ambiguous.

---

## 3. Do not copy English pronoun behavior

Avoid mechanically translating:

- it
- this
- that
- they
- these
- those

Bad:

> この関数はキャッシュを作成します。それは60秒後に失効します。

Better:

> この関数で作成したキャッシュは60秒後に失効する。

If a pronoun sounds unnecessary in Japanese, remove it or merge the sentence.

---

## 4. Prefer Japanese information order

For technical and analytical answers, prefer:

1. Conclusion
2. Reason
3. Conditions or exceptions
4. Details
5. Action or implementation

Bad:

> Node.js のイベントループにはさまざまな特性があります。これらを考慮すると、今回のケースでは worker_threads を使用することが適切です。

Better:

> 今回は `worker_threads` を使うのが適切。Node.js のイベントループだけでは CPU バウンド処理を並列化できないためだ。

Do not delay the main answer just because English exposition often builds toward the conclusion.

---

## 5. Reduce explicit connectives

English frequently uses explicit discourse markers.

Do not mechanically translate:

- However
- Therefore
- Additionally
- Furthermore
- Meanwhile
- On the other hand
- In other words
- As a result
- From this perspective

Japanese often expresses these relations through sentence order, particles, or verb forms.

Bad:

> しかしながら、この方法には問題があります。加えて、パフォーマンスも低下します。

Better:

> ただし、この方法には問題があり、パフォーマンスも落ちる。

Or:

> この方法には問題がある。パフォーマンスも落ちる。

Use a connective only when it improves clarity.

---

## 6. Prefer verbs over translated nominalizations

English often prefers nominalized forms.

Bad:

> 設定の変更を実行することで問題の解決を行えます。

Better:

> 設定を変えれば解決できる。

Bad:

> パフォーマンスの改善を実現します。

Better:

> パフォーマンスが改善する。

When possible, convert:

- implementation → 実装する
- improvement → 改善する
- execution → 実行する
- verification → 確認する
- modification → 変更する
- optimization → 最適化する

Do not turn every English noun into a Japanese noun phrase.

---

## 7. Avoid "ことができます" unless necessary

Bad:

> このコマンドを使用することでログを確認することができます。

Better:

> このコマンドでログを確認できる。

Prefer Japanese potential forms:

- 使える
- 確認できる
- 作れる
- 避けられる
- 減らせる

Use `〜することができます` only when the formal register genuinely requires it.

---

## 8. Do not overuse "という"

Bad:

> race condition という問題が発生する可能性があります。

Better:

> race condition が発生する可能性がある。

Use `という` when defining or quoting a concept, not as filler.

Appropriate:

> 「race condition」とは、実行順序によって結果が変わる競合状態を指す。

---

## 9. Avoid translated bureaucratic phrasing

Check for and simplify these patterns:

- 〜において
- 〜に関して
- 〜の観点から
- 〜となります
- 〜になります
- 〜を提供します
- 〜を可能にします
- 〜の実装を行います
- 〜の改善を行います

Examples:

Bad:

> Laravel において、この設定に関して変更が必要です。

Better:

> Laravel では、この設定を変更する必要がある。

Bad:

> 原因は設定ファイルの競合となります。

Better:

> 原因は設定ファイルの競合です。

Bad:

> こちらが設定ファイルになります。

Better:

> これが設定ファイルです。

---

# Technical Japanese

## 10. Do not over-translate established technical terminology

Preserve standard technical terms when translating them would reduce precision.

Examples that may remain in English when contextually appropriate:

- event loop
- race condition
- deadlock
- cache
- middleware
- hook
- callback
- worker
- thread
- process
- transaction
- migration
- schema
- plugin
- lifecycle
- dependency injection
- lock
- timeout
- retry
- commit
- rollback

Use established Japanese equivalents when they are clearer and standard:

- dependency → 依存関係
- concurrency → 並行性
- parallelism → 並列性
- consistency → 一貫性
- availability → 可用性

Accuracy is more important than forced localization.

---

## 11. Never translate code identifiers

Do not translate:

- function names
- variable names
- configuration keys
- CLI flags
- API names
- class names
- file names
- protocol names

Example:

> `max_threads` を増やしても、`max_concurrent_threads_per_session` が 3 のままなら、単一セッションでは最大3スレッドしか動かない。

---

## 12. Bilingual pairs stay in sync

For a file that exists in two languages — a translation produced beside its
source, such as `README.md` and `README.ja.md` — mirror the source structure
instead of re-authoring it. This is the one place where reconstructing the
sentence flow does not extend to reordering the document.

- Keep the same sections, in the same order, and the same headings. Do not add,
  merge, split, or drop a section because the Japanese reads better that way.
- Keep code blocks, commands, paths, configuration keys, and identifiers
  byte-identical; translate only the prose around them.
- Do not add explanations, caveats, or examples the source does not contain.
- When the source changes, update the pair in the same change rather than
  leaving the two versions describing different behavior.

## 13. Replace vague translated adjectives with concrete effects

Avoid unsupported words such as:

- 良い
- 強力
- 高性能
- 柔軟
- 効率的

Bad:

> この方式の方が効率的です。

Better:

> この方式ならプロセス生成が不要なので、短時間のタスクでは起動コストを抑えられる。

Explain the mechanism.

---

## 14. Preserve modality precisely

Do not flatten these English distinctions:

- must
- need to
- should
- recommended
- optional
- likely
- possible
- uncertain

Suggested mappings:

- must → 必須 / 〜しなければならない
- need to → 〜する必要がある
- should → 〜した方がよい / 〜すべき
- recommended → 推奨
- optional → 任意
- likely → 可能性が高い
- possible → 可能性がある
- uncertain → 断定できない

Do not weaken facts into vague language.
Do not strengthen guesses into facts.

---

# Translation-Smell Patterns

Before finalizing, inspect the draft for these expressions.

| Suspicious pattern | Prefer |
|---|---|
| 〜することができます | 〜できる |
| 〜することが重要です | 〜が重要 / 〜した方がよい |
| 〜ということを意味します | つまり〜 / 〜を意味する |
| 〜の観点から | 〜では / 〜について見ると |
| 〜に関して | 〜について |
| 〜において | 〜では |
| 〜を提供します | 〜がある / 〜を使える / 〜を実現する |
| 〜をサポートします | 対応する |
| 〜を可能にします | 〜できるようにする |
| 〜を実行します | 〜する |
| 〜の実装を行います | 〜を実装する |
| 〜の改善を行います | 〜を改善する |
| 〜であるという事実 | 〜であること |
| これは〜です | usually omit or restructure |
| それは〜です | usually omit or name the referent |
| しかしながら | ただし / しかし / omit |
| 加えて | さらに / また / omit |
| 結果として | その結果 / そのため / omit |

These are not forbidden.
They are warning signs.

---

# English-to-Japanese Failure Patterns

## Pattern 1: "This gives you ..."

Bad:

> これはあなたにより良い制御を与えます。

Better:

> より細かく制御できる。

---

## Pattern 2: "There are three reasons for this."

Literal:

> これには3つの理由があります。

Often better:

> 理由は3つある。

---

## Pattern 3: "The important thing here is ..."

Bad:

> ここで重要なことは、キャッシュが共有されているということです。

Better:

> 重要なのは、キャッシュが共有されている点だ。

Or:

> キャッシュが共有されているのが重要だ。

---

## Pattern 4: "You can think of X as Y."

Bad:

> X を Y として考えることができます。

Better:

> X は Y と考えると分かりやすい。

---

## Pattern 5: "It is worth noting that ..."

Bad:

> 〜ということは注目に値します。

Choose based on context:

> なお、〜

> 注意点として、〜

> ここは重要で、〜

---

## Pattern 6: "In terms of performance ..."

Bad:

> パフォーマンスの観点から見ると、A の方が優れています。

Better:

> パフォーマンスでは A の方が上。

Then explain why.

---

# Register Selection

## Technical / analytical

Use when discussing:

- software
- systems
- APIs
- infrastructure
- architecture
- benchmarks
- debugging
- scientific or analytical topics

Rules:

- Lead with the answer.
- Prefer concise plain Japanese.
- Preserve technical terms.
- State trade-offs explicitly.
- Separate fact, inference, recommendation, and uncertainty.

Example:

> その設計だと競合する。`foo()` と `bar()` が同じ状態を非同期に更新しており、lock も transaction もないためだ。

---

## General explanation

Use clear, natural Japanese.
Do not make the answer unnecessarily formal.

Example:

> 原因はキャッシュです。古い結果が60秒残る設定なので、その間は更新しても画面に反映されません。

---

## Creative / social / conversational writing

Follow the user's requested tone.

Do not "sanitize" the text into generic assistant prose.

Preserve:

- rhythm
- intentional fragments
- slang
- jokes
- sharpness
- character voice

Only remove translation artifacts unless the user asks for broader rewriting.

---

# Self-Check Procedure

Before sending any Japanese answer, perform this internal pass.

## Pass 1: Meaning

Check:

- Did I answer the actual question?
- Is the conclusion correct?
- Are facts and guesses separated?
- Did I preserve important technical distinctions?

## Pass 2: De-translate

Ask:

> If this draft had originally been written in English, can I still see the English sentence skeleton?

If yes, rewrite it.

Look especially for:

- repeated subjects
- repeated pronouns
- explicit connectives
- nominalizations
- `ことができます`
- `ということ`
- `において`
- `に関して`
- `観点から`
- `提供する`
- `可能にする`

## Pass 3: Japanese rhythm

Check:

- Are sentence endings repeating unnaturally?
- Are there too many `です。です。です。` endings?
- Are clauses too long?
- Are particles awkward or repetitive?
- Can two translated-looking sentences be merged naturally?
- Should one long English-style sentence be split?
- Is the subject omitted where Japanese would normally omit it?

## Pass 4: Native-reader test

Ask:

> Would a technically literate native Japanese speaker plausibly write this exact sentence?

If not, rewrite it.

Do not ask:

> Is this grammatically valid Japanese?

Grammatical validity is insufficient.

The target is idiomatic Japanese.

---

# Final Rule

Do not translate English wording.

Translate the intended meaning, then write the answer again in Japanese.

The internal pipeline should conceptually be:

```text
user intent
  ↓
semantic understanding
  ↓
reasoning / planning
  ↓
language-independent answer structure
  ↓
Japanese reconstruction
  ↓
translation-smell removal
  ↓
final Japanese answer
```

NOT:

```text
English answer
  ↓
sentence-by-sentence Japanese translation
```

The final response should feel authored in Japanese even if the model's internal reasoning is English-dominant.
