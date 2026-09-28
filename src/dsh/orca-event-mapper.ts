import type { EventInit } from '@orcareplay/core'
import type { OrcaConfig } from './config.js'
import { projectOrcaJson, scrubOrcaText } from './orca-security.js'
import { OrcaError } from './orca-types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { isKiokukoDshSource } from './plugin-source.js'

export const ORCA_CAPTURE = Object.freeze({ format: 'dsh.observation.v1', httpCapture: false, filesystemSnapshot: false, exactReplay: false,
  shellFrames: false, mcpTransport: false, environment: false, replayState: false, attachments: false })
export const record = (value: unknown): Record<string, any> => typeof value === 'object' && value !== null ? value as Record<string, any> : {}
export function label(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  if (value.length > 512) throw new OrcaError('metadata_limit')
  return scrubOrcaText(value).replace(/[\p{Cc}]/gu, '')
}
export function projectBlocks(value: unknown, config: OrcaConfig): unknown[] {
  if (!Array.isArray(value)) return []
  if (value.length * 64 > config.maxQueuedBytesPerTrace) throw new OrcaError('queue_limit')
  return value.map(item => {
    const block = record(item)
    if (block.type === 'reasoning' && !config.capture.reasoning) return { type: 'reasoning', omitted: true }
    if (block.type === 'text' || block.type === 'reasoning') return config.capture.content === 'metadata'
      ? { type: block.type, chars: typeof block.text === 'string' ? block.text.length : 0 }
      : { type: block.type, text: block.text }
    if (block.type === 'tool-call') return { type: 'tool-call', id: label(block.id), name: label(block.name),
      ...(config.capture.content === 'metadata' ? {} : { arguments: block.arguments }) }
    if (block.type === 'tool-result') return { type: 'tool-result', id: label(block.id), omitted: true }
    return { type: label(block.type), omitted: true }
  })
}

/** Hash only host-attributed sections still present at the final request seam. */
export function requestSourceManifest(messages: unknown, config: OrcaConfig): {
  coverage: 'observed' | 'partial' | 'unknown'; omittedCount: number;
  items: { kind: string; id: string; digest: string; bytes: number }[]
} {
  if (!Array.isArray(messages)) return { coverage: 'unknown', omittedCount: 0, items: [] }
  const items: { kind: string; id: string; digest: string; bytes: number }[] = []
  let omittedCount = 0
  const limit = Math.min(16_384, Math.floor(config.maxQueuedBytesPerTrace / 8))
  for (const value of messages) {
    const message = record(value), source = record(message.source)
    const host = message.role === 'user' && source.form === 'snapshot'
      && (isKiokukoDshSource(source) || source.kind === 'runtime-context')
    if (!host || !Array.isArray(source.sections) || !Array.isArray(message.content)) continue
    const rendered = message.content.find((block: unknown) => record(block).type === 'text')
    const body = record(rendered).text
    if (typeof body !== 'string') continue
    for (const candidate of source.sections) {
      const section = record(candidate)
      if (typeof section.name !== 'string' || typeof section.text !== 'string'
        || section.name.length > 256 || !body.includes(section.text)) continue
      if (source.kind === 'runtime-context' && section.name !== 'kiokuko:execution') continue
      if (source.kind !== 'runtime-context' && !/^(?:soul|directive|memory-reasoning|route-skill|expert|advisory|memory|user-task):/u.test(section.name)) continue
      const kind = source.kind === 'runtime-context' ? 'execution' : section.name.split(':', 1)[0]!
      const item = { kind, id: label(section.name), digest: canonicalContentHash(section.text),
        bytes: Buffer.byteLength(section.text) }
      if (items.length >= 64 || Buffer.byteLength(JSON.stringify({ coverage: 'partial', omittedCount: omittedCount + 1,
        items: [...items, item] })) > limit) { omittedCount++; continue }
      items.push(item)
    }
  }
  return { coverage: omittedCount ? 'partial' : items.length ? 'observed' : 'unknown', omittedCount, items }
}
export function modelRequest(options: Record<string, any>, id: string, config: OrcaConfig): EventInit {
  const messages = Array.isArray(options.messages) ? options.messages : []
  if (messages.length * 64 > config.maxQueuedBytesPerTrace) throw new OrcaError('queue_limit')
  const sources = requestSourceManifest(options.messages, config)
  const payload = config.capture.content === 'metadata' ? { format: 'dsh.llm.request.v1', sources } : {
    format: 'dsh.llm.request.v1', system: options.system,
    sources,
    messages: messages.map(item => ({ role: label(record(item).role), content: projectBlocks(record(item).content, config) })),
    tools: Array.isArray(options.tools) ? options.tools.map(item => ({ name: label(record(item).name) })) : [],
  }
  return { type: 'model.request', actor: 'harness', attrs: { modelCallId: id, provider: label(options.provider), model: label(options.model),
    messages: messages.length, purpose: options.purpose === undefined ? 'conversation' : label(options.purpose) },
    payload: projectOrcaJson(payload, config.maxQueuedBytesPerTrace) as Record<string, unknown> }
}
/** DSH uses a replacement usage snapshot, with disjoint cache counters. */
export function usageAttrs(value: unknown): Record<string, unknown> {
  const source = record(value)
  const numeric = (key: string) => typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0 ? source[key] as number : undefined
  const input = numeric('inputTokens'), output = numeric('outputTokens'), read = numeric('cacheReadTokens'), write = numeric('cacheWriteTokens')
  return { usage_known: input !== undefined && output !== undefined,
    ...(input === undefined ? {} : { input_tokens: input + (read ?? 0) + (write ?? 0), uncached_input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(read === undefined ? {} : { cache_read_tokens: read }), ...(write === undefined ? {} : { cache_write_tokens: write }) }
}
