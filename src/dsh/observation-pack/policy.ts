import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { CompactionSession, SurfaceEvent, SurfaceMessage } from '../semantic-compaction/contracts.js'
import { surfaceMessage } from '../semantic-compaction/policy.js'

export const ObservationPackConfig = z.object({ mode: z.enum(['auto', 'off']).default('auto') }).strict()
export const OBSERVATION_MARKER = '[Kiokuko ObservationPack v1]'
export const ObservationReadInput = z.object({ handle: z.string().regex(/^op1\.\d+\.[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(2000).default(2000) }).strict()
export const textDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
export function plainResult(event: SurfaceEvent): { message: SurfaceMessage; text: string; callId: string } | undefined {
  const message = surfaceMessage(event), block = message?.content[0]
  if (event.type === 'tool/result' && message?.role === 'tool' && message.source.kind === 'tool'
    && typeof message.toolCallId === 'string' && message.source.callId === message.toolCallId
    && message.isError === false && event.data.error === undefined && message.content.length === 1
    && block?.type === 'text' && typeof block.text === 'string'
    && !Object.keys(block).some(k => !['type', 'text'].includes(k)))
    return { message, text: block.text, callId: message.toolCallId }
  const text = block?.content?.[0]
  if (event.type !== 'tool/result' || !message || message.role !== 'user' || message.source.kind !== 'tool' || message.content.length !== 1
    || block?.type !== 'tool-result' || typeof block.toolCallId !== 'string' || message.source.callId !== block.toolCallId
    || block.isError !== false || event.data.error !== undefined || block.content?.length !== 1
    || Object.keys(block).some(k => !['type', 'toolCallId', 'content', 'isError'].includes(k))
    || text?.type !== 'text' || typeof text.text !== 'string' || Object.keys(text).some(k => !['type', 'text'].includes(k))) return undefined
  return { message, text: text.text, callId: block.toolCallId }
}
export function observationHandle(sessionId: string, event: SurfaceEvent): string {
  const result = plainResult(event)
  if (!result) throw new Error('Invalid observation source')
  return `op1.${event.seq}.${canonicalContentHash({ sessionId, seq: event.seq, callId: result.callId, digest: textDigest(result.text) })}`
}
/** Complete lines only; an oversized single line contributes no excerpt. */
export function observationExcerpt(text: string): string {
  const start = text.slice(0, 1024), prefix = start.split(/(?<=\n)/u)
  if (start.length < text.length && !start.endsWith('\n')) prefix.pop()
  let head = '', tail = ''
  for (const line of prefix) { if (Buffer.byteLength(head + line) > 512) break; head += line }
  const suffix = text.slice(Math.max(0, text.length - 2048)).split(/(?<=\n)/u)
  // The first fragment may start in the middle of a line.
  if (text.length > 2048) suffix.shift()
  for (const line of suffix.reverse()) { if (Buffer.byteLength(line + tail) > 512) break; tail = line + tail }
  return `${head}\n…\n${tail}`
}
export function packedMessage(sessionId: string, event: SurfaceEvent): SurfaceMessage {
  const result = plainResult(event)!
  const text = `${OBSERVATION_MARKER}\n${JSON.stringify({ session: sessionId, handle: observationHandle(sessionId, event), bytes: Buffer.byteLength(result.text), digest: textDigest(result.text) })}\nUse observation_read for the original (Unicode offset, up to 2000 characters).\n${observationExcerpt(result.text)}`
  return { ...result.message, content: result.message.role === 'tool'
    ? [{ type: 'text', text }]
    : [{ ...result.message.content[0]!, content: [{ type: 'text', text }] }] }
}
/** Resolve only a native result, never a caller-supplied path or session. */
export function resolveObservation(session: CompactionSession, handle: string): SurfaceEvent {
  if (!/^op1\.\d+\.[a-f0-9]{64}$/u.test(handle)) throw new Error('Invalid observation handle')
  const seq = Number(handle.split('.')[1]), event = session.eventAt(seq)
  if (!Number.isSafeInteger(seq) || !event || observationHandle(session.id, event) !== handle) throw new Error('Observation handle does not belong to this session')
  return event
}
export function packedSource(session: CompactionSession, event: SurfaceEvent): SurfaceEvent | undefined {
  if (event.sourceEventSeqs?.length !== 1) return undefined
  const original = session.eventAt(event.sourceEventSeqs[0]!)
  if (!original || original.type !== 'tool/result' || !plainResult(original) || !plainResult(event)) return undefined
  const text = plainResult(event)!.text
  if (!text.startsWith(`${OBSERVATION_MARKER}\n`)) return undefined
  let metadata: unknown
  try { metadata = JSON.parse(text.split('\n', 3)[1]!) } catch { return undefined }
  const origin = (metadata as { session?: unknown })?.session
  return typeof origin === 'string' && canonicalContentHash(packedMessage(origin, original)) === canonicalContentHash(surfaceMessage(event)) ? original : undefined
}
