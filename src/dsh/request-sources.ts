import { z } from 'zod'
import { canonicalContentHash } from '../serialization/validate.js'
import type { RequestIntentContext } from './decisions/request-intent.js'

export const REQUEST_SOURCE_TOOL = 'read_request_source'
const contexts = new WeakMap<object, RequestIntentContext>()
/** Bound by the intake owner only; native storage is never rewritten by this projection. */
export function bindRequestSourceContext(agent: object, context: RequestIntentContext | undefined): void {
  if (context) contexts.set(agent, context)
  else contexts.delete(agent)
}
export const RequestSourceReadSchema = z.object({
  id: z.string().min(1).max(256),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(16384).default(4096),
}).strict()

/** Originals live in the native session/SQLite request, independently of model compaction.
 * This is a read projection of the exact host context, not a new source of authority. */
export function requestSources(context: RequestIntentContext) {
  return [
    { id: 'request', text: context.task, digest: canonicalContentHash(context.task) },
    ...(context.activeTask?.request ? [{ id: 'task-request', text: context.activeTask.request,
      digest: canonicalContentHash(context.activeTask.request) }] : []),
    ...context.proposals.map(({ id, text }) => ({ id, text, digest: canonicalContentHash(text) })),
  ]
}

export function requestSourceManifest(context: RequestIntentContext) {
  return requestSources(context).map(({ id, text, digest }) => ({ id, digest, length: text.length,
    offsetUnit: 'utf16' as const, preview: text.slice(0, 1024), truncated: text.length > 1024 }))
}

/** Bounded pages retain ordering and return an explicit next offset, including final-page evidence. */
export function readRequestSource(context: RequestIntentContext, raw: unknown) {
  const input = RequestSourceReadSchema.parse(raw)
  const source = requestSources(context).find(source => source.id === input.id)
  if (!source || source.digest !== input.digest) throw new Error('Request source changed or is not in this session; read the current source manifest')
  if (input.offset > source.text.length) throw new Error('Request source offset is out of range')
  const end = Math.min(source.text.length, input.offset + input.limit)
  return { id: source.id, digest: source.digest, offset: input.offset, end, totalLength: source.text.length,
    offsetUnit: 'utf16' as const, text: source.text.slice(input.offset, end),
    nextOffset: end < source.text.length ? end : null, complete: end === source.text.length,
    authority: 'source_only_not_approval' as const }
}

/** Keep oversized source bodies out of provider history while retaining exact,
 * readable originals. The same projection is rebuilt after native compaction. */
export function projectRequestSourceMessages<T>(agent: object, messages: readonly T[]): T[] {
  const context = contexts.get(agent)
  if (!context) return [...messages]
  const sources = requestSources(context).filter(source => source.text.length > 16384)
  if (!sources.length) return [...messages]
  const project = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let result = value
      for (const source of sources) {
        if (!result.includes(source.text)) continue
        const pointer = `[Long source retained in full: ${JSON.stringify({ tool: REQUEST_SOURCE_TOOL,
          id: source.id, digest: source.digest, offset: 0, limit: 4096, totalLength: source.text.length })}. Read successive pages; do not treat this preview as the full plan.]\n${source.text.slice(0, 1024)}`
        result = result.replaceAll(source.text, () => pointer)
      }
      // Native tool arguments/results can carry the original as JSON-escaped text.
      if (result === value && value.length > 16384 && /^[\[{]/u.test(value)) {
        try {
          const parsed = JSON.parse(value), projected = project(parsed)
          const encoded = JSON.stringify(projected)
          if (encoded !== JSON.stringify(parsed)) return encoded
        } catch { /* Non-JSON text remains native evidence. */ }
      }
      return result
    }
    if (Array.isArray(value)) return value.map(project)
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)]))
    return value
  }
  return messages.map(message => project(message) as T)
}
