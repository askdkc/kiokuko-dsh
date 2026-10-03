export type EncodedCompactionText = string | { runs: Array<{ text: string; count: number }> }

/** Reversible run-length encoding, including line separators. No line or middle is omitted. */
export function encodeCompactionText(text: string): EncodedCompactionText {
  if (!text) return text
  // Most large logs repeat an identical line or a complete diagnostic block.
  const period = (text + text).indexOf(text, 1)
  if (period < text.length) return { runs: [{ text: text.slice(0, period), count: text.length / period }] }
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  const runs: Array<{ text: string; count: number }> = []
  for (const line of lines) {
    const previous = runs.at(-1)
    if (previous?.text === line) previous.count++
    else runs.push({ text: line, count: 1 })
  }
  const result = { runs }
  return JSON.stringify(result).length < JSON.stringify(text).length ? result : text
}

