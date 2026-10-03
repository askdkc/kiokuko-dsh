import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalContentHash } from '../../serialization/validate.js'
import { encodeCompactionText } from './text-runs.js'
import type { ResultCandidate, SurfaceMessage } from './contracts.js'

export const LOSSLESS_COMPACTION_MARKER = '[Kiokuko lossless tool output: concatenate JSON runs in order, repeating each text count times.]'
export const LOSSLESS_COMPACTION_LIMIT = 2_000_000
const sourceSchema = z.object({ callId: z.string().min(1), eventSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
const envelopeSchema = z.object({
  codec: z.literal('kiokuko-text-runs-v1'), source: sourceSchema,
  sha256Utf16le: z.string().regex(/^[a-f0-9]{64}$/), codeUnits: z.number().int().min(1).max(LOSSLESS_COMPACTION_LIMIT),
  runs: z.array(z.object({ text: z.string().min(1), count: z.number().int().min(1).max(LOSSLESS_COMPACTION_LIMIT) }).strict()).min(1),
}).strict()
type Source = z.infer<typeof sourceSchema>
const digest = (text: string) => createHash('sha256').update(text, 'utf16le').digest('hex')

/** Public, readable representation. The decoder proves exact order and UTF-16 equality. */
export function decodeLosslessCompaction(text: string, source?: Source): string {
  if (!text.startsWith(`${LOSSLESS_COMPACTION_MARKER}\n`) || text.length > LOSSLESS_COMPACTION_LIMIT) throw new Error('Invalid lossless compaction envelope')
  const value = envelopeSchema.parse(JSON.parse(text.slice(LOSSLESS_COMPACTION_MARKER.length + 1)))
  if (source && (value.source.callId !== source.callId || value.source.eventSeq !== source.eventSeq)) throw new Error('Lossless compaction source mismatch')
  let length = 0
  for (const run of value.runs) {
    length += run.text.length * run.count
    if (!Number.isSafeInteger(length) || length > value.codeUnits) throw new Error('Lossless compaction expansion exceeds declared size')
  }
  if (length !== value.codeUnits) throw new Error('Lossless compaction length mismatch')
  const original = value.runs.map(run => run.text.repeat(run.count)).join('')
  if (digest(original) !== value.sha256Utf16le) throw new Error('Lossless compaction digest mismatch')
  return original
}

export function encodeLosslessCompaction(original: string, source: Source): string | undefined {
  if (!original || original.length > LOSSLESS_COMPACTION_LIMIT) return undefined
  sourceSchema.parse(source)
  const encoded = encodeCompactionText(original)
  if (typeof encoded === 'string') return undefined
  const replacement = `${LOSSLESS_COMPACTION_MARKER}\n${JSON.stringify({ codec: 'kiokuko-text-runs-v1', source,
    sha256Utf16le: digest(original), codeUnits: original.length, runs: encoded.runs })}`
  if (replacement.length >= original.length) return undefined
  if (decodeLosslessCompaction(replacement, source) !== original) throw new Error('Lossless compaction round-trip mismatch')
  return replacement
}

function body(message: SurfaceMessage): { text: string; assign(text: string): void } {
  const block = message.role === 'tool' ? message.content[0] : message.content[0]?.content?.[0]
  if (!block || block.type !== 'text' || typeof block.text !== 'string') throw new Error('Invalid lossless compaction message')
  return { text: block.text, assign(text: string) { block.text = text } }
}

/** Host proof at admission and again immediately before committing; model claims are irrelevant. */
export function verifyLosslessCandidate(candidate: ResultCandidate): void {
  const reconstructed = structuredClone(candidate.replacement)
  const original = decodeLosslessCompaction(body(reconstructed).text, { callId: candidate.callId, eventSeq: candidate.event.seq })
  body(reconstructed).assign(original)
  if (original !== body(candidate.original).text || canonicalContentHash(reconstructed) !== canonicalContentHash(candidate.original))
    throw new Error('Lossless compaction changed message evidence or pairing')
}
