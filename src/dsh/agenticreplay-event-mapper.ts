import type { EventInit } from './agenticreplay-libraries.js'
import type { AgenticReplayConfig } from './config.js'
import { projectAgenticReplayJson, scrubAgenticReplayText } from './agenticreplay-security.js'
import { AgenticReplayError } from './agenticreplay-types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { isKiokukoDshSource } from './plugin-source.js'

export const AGENTICREPLAY_CAPTURE = Object.freeze({ format: 'dsh.observation.v1', httpCapture: false, filesystemSnapshot: false, exactReplay: false,
  shellFrames: false, mcpTransport: false, environment: false, replayState: false, attachments: false })
export const record = (value: unknown): Record<string, any> => typeof value === 'object' && value !== null ? value as Record<string, any> : {}
export function label(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  if (value.length > 512) throw new AgenticReplayError('metadata_limit')
  return scrubAgenticReplayText(value).replace(/[\p{Cc}]/gu, '')
}
export function projectBlocks(value: unknown, config: AgenticReplayConfig): unknown[] {
  if (!Array.isArray(value)) return []
  if (value.length * 64 > config.maxQueuedBytesPerTrace) throw new AgenticReplayError('queue_limit')
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

export function boundedAgenticReplayPayload(value: unknown, maxBytes: number, format: string): {
  payload: Record<string, unknown>; omitted: boolean; omissionReason?: string;
} {
  try {
    const projected = projectAgenticReplayJson(value, maxBytes)
    if (typeof projected !== 'object' || projected === null || Array.isArray(projected)) throw new AgenticReplayError('unsupported_payload')
    return { payload: projected as Record<string, unknown>, omitted: false }
  } catch (error) {
    if (!(error instanceof AgenticReplayError) || error.code !== 'queue_limit') throw error
    return { payload: { format, content_omitted: true, omission_reason: 'payload_limit' }, omitted: true, omissionReason: 'payload_limit' }
  }
}

/** Hash only host-attributed sections still present at the final request seam. */
export function requestSourceManifest(messages: unknown, config: AgenticReplayConfig): {
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
      if (typeof section.name !== 'string' || typeof section.text !== 'string' || section.name.length > 256) continue
      if (Buffer.byteLength(section.text) > limit) { omittedCount++; continue }
      if (!body.includes(section.text)) continue
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
export function modelRequest(options: Record<string, any>, id: string, config: AgenticReplayConfig): EventInit {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const sources = requestSourceManifest(options.messages, config)
  const attrs = { modelCallId: id, provider: label(options.provider), model: label(options.model),
    messages: messages.length, purpose: options.purpose === undefined ? 'conversation' : label(options.purpose) }
  try {
    if (messages.length * 64 > config.maxQueuedBytesPerTrace) throw new AgenticReplayError('queue_limit')
    // Native message IDs and producer labels survive history/retry boundaries.
    // Do not serialize source objects: they can carry private adapter replay state.
    const origins = messages.map((value, index) => {
      const message = record(value),
        source = record(message.source)
      return {
        index,
        role: label(message.role),
        ...(typeof message.id === 'string' ? { id: label(message.id) } : {}),
        ...(typeof source.kind === 'string'
          ? { producer: label(source.kind) }
          : {}),
        ...(source.kind === 'plugin' && typeof source.plugin === 'string'
          ? { plugin: label(source.plugin) }
          : {}),
        ...(typeof source.form === 'string' ? { form: label(source.form) } : {}),
        ...(Array.isArray(source.sections)
          ? { sections: source.sections.map((value) => label(record(value).name)) }
          : {}),
        ...(message.role === 'tool' && typeof message.toolCallId === 'string'
          ? { toolCallId: label(message.toolCallId) }
          : {}),
      }
    })
    const payload = config.capture.content === 'metadata' ? { format: 'dsh.llm.request.v1', sources, origins } : {
      format: 'dsh.llm.request.v1', system: options.system, sources, origins,
      messages: messages.map(item => ({ role: label(record(item).role), content: projectBlocks(record(item).content, config) })),
      tools: Array.isArray(options.tools) ? options.tools.map(item => ({ name: label(record(item).name) })) : [],
    }
    return { type: 'model.request', actor: 'harness', attrs,
      payload: projectAgenticReplayJson(payload, config.maxQueuedBytesPerTrace) as Record<string, unknown> }
  } catch (error) {
    if (!(error instanceof AgenticReplayError) || error.code !== 'queue_limit') throw error
    return { type: 'model.request', actor: 'harness', attrs: { ...attrs, content_omitted: true, omission_reason: 'payload_limit' },
      payload: { format: 'dsh.llm.request.v1', sources, origins_omitted: true, content_omitted: true, omission_reason: 'payload_limit' } }
  }
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


/** Classify only the native result envelope; JSON/text returned as domain data is not an error signal. */
export function toolResultOutcome(value: Record<string, any>, toolName?: string): Record<string, unknown> {
  const error = record(value.error)
  const structured = Object.keys(error).length > 0
  const process = record(value.value)
  const processFailed = process.timedOut === true || process.aborted === true
    || typeof process.signal === 'string' && process.signal.length > 0
    || Number.isSafeInteger(process.exitCode) && process.exitCode !== 0
  const failed = value.isError === true || structured || processFailed
  const processResult = Object.fromEntries(Object.entries(process).filter(([key, item]) =>
    key === 'exitCode' ? item === null || Number.isSafeInteger(item)
      : key === 'signal' ? item === null || typeof item === 'string'
        : ['timedOut', 'aborted', 'processStarted', 'processStopped', 'outputComplete'].includes(key) && typeof item === 'boolean'))
  return { is_error: failed, native_is_error: value.isError,
    ...(Object.keys(processResult).length && ['bash','kioku_exec'].includes(toolName ?? '') ? { process_result: processResult } : {}),
    ...(structured ? { error_source: 'native_error_envelope' } : processFailed ? { error_source: 'native_process_result' } : {}),
    ...(failed && value.isError === false ? { error_flag_conflict: true } : {}) }
}
