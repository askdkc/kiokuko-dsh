import type { EventInit } from '@orcareplay/core'
import type { OrcaConfig } from './config.js'
import { projectOrcaJson, scrubOrcaText } from './orca-security.js'
import { OrcaError } from './orca-types.js'

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
export function modelRequest(options: Record<string, any>, id: string, config: OrcaConfig): EventInit {
  const messages = Array.isArray(options.messages) ? options.messages : []
  if (messages.length * 64 > config.maxQueuedBytesPerTrace) throw new OrcaError('queue_limit')
  const payload = config.capture.content === 'metadata' ? { format: 'dsh.llm.request.v1' } : {
    format: 'dsh.llm.request.v1', system: options.system,
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
