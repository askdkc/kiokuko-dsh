/** Native DSH adapter for Zen/Go; catalog and wire dispatch never consult pi. */
import { LlmAdapter, LlmError, attributionHeaders, type GenerateOptions, type StreamChunk, type ContentBlock, type PreparedAdapterCall, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LanguageModelV4StreamPart, SharedV4ProviderOptions } from '@ai-sdk/provider'
import { encodePrompt } from './opencode-codec.js'
import { createTransport } from './opencode-transport.js'
import { type OpenCodeCatalog, type OpenCodeModel, type OpenCodeRoute } from './opencode-catalog.js'
import type { CredentialFile } from './credentials.js'
import { abortable } from './abortable.js'
import { randomUUID } from 'node:crypto'
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { record, mergeMetadata } from './opencode-replay.js'

/** Exact decimal normalization: no floating-point rounding, including huge exponents. */
function canonicalJsonNumber(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!match) throw new Error('Invalid tool JSON number')
  const fraction = match[3] ?? ''
  const digits = (match[2]! + fraction).replace(/^0+/, '')
  // Preserve signed zero: changing it can affect downstream numeric operations.
  if (!digits) return `${match[1]}0`
  const significant = digits.replace(/0+$/, '')
  const exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length) + BigInt(digits.length - significant.length)
  return `${match[1]}${significant}e${exponent}`
}

/** Ignore JSON formatting, but never round numeric tokens or erase duplicate keys. */
function sameToolArguments(streamed: string, complete: string): boolean {
  if (streamed === complete) return true
  const canonical = (source: string): string => {
    const errors: ParseError[] = []
    const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false })
    if (!root || errors.length) throw new Error('Invalid tool JSON')
    const visit = (node: JsonNode): unknown => {
      if (node.type === 'object') {
        const seen = new Set<string>()
        const entries = (node.children ?? []).map(property => {
          const key = property.children![0]!.value as string
          if (seen.has(key)) throw new Error('Ambiguous tool JSON key')
          seen.add(key)
          return [key, visit(property.children![1]!)] as const
        }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        return ['object', entries]
      }
      if (node.type === 'array') return ['array', (node.children ?? []).map(visit)]
      // JSON.parse would alias distinct integers above Number.MAX_SAFE_INTEGER.
      return [node.type, node.type === 'number' ? canonicalJsonNumber(source.slice(node.offset, node.offset + node.length)) : node.value]
    }
    return JSON.stringify(visit(root))
  }
  try { return canonical(streamed) === canonical(complete) } catch { return false }
}

interface Options {
  catalogs: ReadonlyMap<OpenCodeRoute, OpenCodeCatalog>; store: CredentialFile
  attachments?: () => AttachmentStore | undefined; fetcher?: typeof fetch
  overrides?: Record<string, Record<string, { contextWindow?: number; maxTokens?: number }>>
  warn?: (reason: string) => void
}
export class OpenCodeAdapter extends LlmAdapter {
  constructor(private readonly options: Options) {
    super()
    for (const [provider, models] of Object.entries(options.overrides ?? {})) for (const [id, override] of Object.entries(models)) {
      if (!options.catalogs.has(provider as OpenCodeRoute)) continue
      this.descriptor(provider, id)
      for (const value of Object.values(override)) if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid model override for ${provider}/${id}`)
    }
  }
  override providerInfo(provider: string) { return { id: provider, name: provider === 'opencode' ? 'OpenCode Zen' : 'OpenCode Go' } }
  private descriptor(provider: string, id: string): OpenCodeModel {
    const catalog = this.options.catalogs.get(provider as OpenCodeRoute)
    const found = catalog?.models().find(model => model.id === id)
    if (!found) throw new LlmError(`OpenCode model ${provider}/${id} unavailable: ${catalog?.status().excluded.find(model => model.id === id)?.reason ?? 'not on the verified roster'}`, 'MODEL_NOT_FOUND')
    const override = this.options.overrides?.[provider]?.[id]
    return { ...found, ...override }
  }
  override async listModels(provider: string) {
    if (!(await this.options.store.read(provider))) return []
    return (this.options.catalogs.get(provider as OpenCodeRoute)?.models() ?? []).map(model => ({ provider, id: model.id, name: model.name, inputModalities: model.inputModalities }))
  }
  private resolved(provider: string, descriptor: OpenCodeModel): LlmResolvedModelInfo {
    return { provider, id: descriptor.id, name: descriptor.name, inputModalities: descriptor.inputModalities, context: { contextWindow: descriptor.contextWindow }, defaultMaxTokens: descriptor.maxTokens,
      ...(descriptor.efforts.length ? { reasoning: { efforts: descriptor.efforts.map(id => ({ id: id as NonNullable<LlmResolvedModelInfo['reasoning']>['efforts'][number]['id'], name: id })) } } : {}) }
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.resolved(provider, this.descriptor(provider, model)) }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted(); const descriptor = this.descriptor(provider, model)
    return { model: this.resolved(provider, descriptor), stream: options => {
      if (options.provider !== provider || options.model !== model) throw new LlmError('Prepared OpenCode call identity mismatch', 'INVALID_PREPARED_CALL')
      return this.dispatch(options, descriptor)
    } }
  }
  override stream(options: GenerateOptions) { return this.dispatch(options, this.descriptor(options.provider, options.model)) }
  private async *dispatch(options: GenerateOptions, descriptor: OpenCodeModel): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (options.tools?.length && !descriptor.toolCall) throw new LlmError('This OpenCode model does not support tool calls', 'UNSUPPORTED_CAPABILITY')
    if (options.reasoningEffort && !descriptor.efforts.includes(options.reasoningEffort)) throw new LlmError('Unsupported reasoning effort for this model', 'UNSUPPORTED_CAPABILITY')
    const prompt = await encodePrompt(options, descriptor, this.options.attachments, this.options.warn)
    const credential = await this.options.store.read(options.provider)
    if (credential?.type !== 'api_key' || !credential.key?.trim()) throw new LlmError(`Run /auth login ${options.provider}`, 'AUTH')
    const headers = { ...attributionHeaders(), 'x-opencode-session': options.sessionId ?? randomUUID() }
    const model = createTransport(descriptor, options, credential.key, headers, prompt, this.options.fetcher)
    const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])])
    let timer = setTimeout(() => abort.abort(new Error('OpenCode stream idle timeout')), 300_000); timer.unref()
    let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined
    try {
      const result = await abortable(model.doStream({ prompt, abortSignal: signal, maxOutputTokens: options.maxTokens ?? descriptor.maxTokens,
        ...(descriptor.temperature && options.temperature !== undefined ? { temperature: options.temperature } : {}), ...(options.stop ? {stopSequences:options.stop} : {}),
        ...(options.tools ? {tools: options.tools.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, inputSchema: tool.parameters }))} : {}),
        ...(descriptor.protocol === 'responses' ? {providerOptions: { openai: { store: false } }} : {}) }), signal)
      reader = result.stream.getReader()
      const blocks = new Map<string, { index: number; block: ContentBlock; providerOptions?: SharedV4ProviderOptions | undefined; ended: boolean; inputEnded?: boolean }>(); let responseId: string | undefined
      while (true) {
        const item = await abortable(reader.read(), signal); if (item.done) throw new LlmError('OpenCode stream ended without a finish event', 'PROTOCOL_ERROR')
        clearTimeout(timer); timer = setTimeout(() => abort.abort(new Error('OpenCode stream idle timeout')), 300_000); timer.unref()
        const part = item.value
        if (part.type === 'error') throw part.error
        if (part.type === 'response-metadata') { responseId = part.id; continue }
        if (part.type === 'text-start' || part.type === 'reasoning-start' || part.type === 'tool-input-start') {
          if (part.type === 'tool-input-start' && part.providerExecuted) throw new LlmError('Unexpected provider-executed tool', 'PROTOCOL_ERROR')
          // IDs remain reserved after a block closes: reusing one would overwrite
          // replay state and alias assembler indexes.
          if (blocks.has(part.id)) throw new LlmError('Duplicate stream block ID', 'PROTOCOL_ERROR')
          const block: ContentBlock = part.type === 'tool-input-start' ? { type: 'tool-call', id: part.id as Extract<ContentBlock, { type: 'tool-call' }>['id'], name: part.toolName, arguments: '' } : { type: part.type === 'text-start' ? 'text' : 'reasoning', text: '' }
          const entry = { index: blocks.size, block, ended: false, providerOptions: part.providerMetadata }; blocks.set(part.id, entry)
          yield { type: 'block-start', index: entry.index, blockType: block.type }; continue
        }
        if (part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta') {
          const entry = blocks.get(part.id); if (!entry || entry.ended || entry.inputEnded) throw new LlmError('Unmatched stream delta', 'PROTOCOL_ERROR')
          const expected = part.type === 'tool-input-delta' ? 'tool-call' : part.type === 'text-delta' ? 'text' : 'reasoning'
          if (entry.block.type !== expected) throw new LlmError('Mismatched stream delta type', 'PROTOCOL_ERROR')
          if (entry.block.type === 'tool-call') { entry.block.arguments += part.delta; yield { type: 'tool-call-delta', index: entry.index, id: entry.block.id, argumentsDelta: part.delta } }
          else if (entry.block.type === 'text' || entry.block.type === 'reasoning') { entry.block.text += part.delta; yield { type: entry.block.type === 'text' ? 'text-delta' : 'reasoning-delta', index: entry.index, text: part.delta } }
          if (part.providerMetadata) entry.providerOptions = mergeMetadata(entry.providerOptions, part.providerMetadata); continue
        }
        if (part.type === 'text-end' || part.type === 'reasoning-end' || part.type === 'tool-input-end') {
          const entry = blocks.get(part.id); if (!entry || entry.ended || entry.inputEnded) throw new LlmError('Unmatched stream end', 'PROTOCOL_ERROR')
          const expected = part.type === 'tool-input-end' ? 'tool-call' : part.type === 'text-end' ? 'text' : 'reasoning'
          if (entry.block.type !== expected) throw new LlmError('Mismatched stream end type', 'PROTOCOL_ERROR')
          if (part.providerMetadata) entry.providerOptions = mergeMetadata(entry.providerOptions, part.providerMetadata)
          if (entry.block.type === 'tool-call') { entry.inputEnded = true; continue }
          entry.ended = true; yield { type: 'block-end', index: entry.index, block: entry.block }; continue
        }
        if (part.type === 'tool-call') {
          if (part.providerExecuted) throw new LlmError('Unexpected provider-executed tool', 'PROTOCOL_ERROR')
          if (!blocks.has(part.toolCallId)) { const block: ContentBlock = { type: 'tool-call', id: part.toolCallId as Extract<ContentBlock, { type: 'tool-call' }>['id'], name: part.toolName, arguments: part.input }; const index = blocks.size; blocks.set(part.toolCallId, { index, block, ended: true, providerOptions: part.providerMetadata }); yield { type: 'block-start', index, blockType: 'tool-call' }; yield { type: 'block-end', index, block } }
          else {
            const entry = blocks.get(part.toolCallId)!
            if (entry.block.type !== 'tool-call' || entry.ended || entry.block.name !== part.toolName) throw new LlmError('Mismatched final tool call', 'PROTOCOL_ERROR')
            // Some providers send the complete arguments only in the final
            // tool event. When both exist, require equivalent JSON while
            // retaining the original streamed bytes for lossless replay.
            if (entry.block.arguments && !sameToolArguments(entry.block.arguments, part.input)) throw new LlmError('Conflicting final tool arguments', 'PROTOCOL_ERROR')
            if (!entry.block.arguments) entry.block.arguments = part.input
            if (part.providerMetadata) entry.providerOptions = mergeMetadata(entry.providerOptions, part.providerMetadata)
            entry.ended = true; yield { type: 'block-end', index: entry.index, block: entry.block }
          }
          continue
        }
        if (part.type === 'finish') {
          for (const entry of blocks.values()) if (!entry.ended) { entry.ended = true; yield { type: 'block-end', index: entry.index, block: entry.block } }
          const input = part.usage.inputTokens; const output = part.usage.outputTokens
          // DSH snapshots chunks losslessly: optional SDK values must be absent,
          // not own properties containing undefined. Preserve reported zeroes.
          yield { type: 'usage', usage: {
            inputTokens: input.noCache ?? Math.max(0, (input.total ?? 0) - (input.cacheRead ?? 0) - (input.cacheWrite ?? 0)),
            outputTokens: output.total ?? 0,
            ...(input.cacheRead !== undefined ? { cacheReadTokens: input.cacheRead } : {}),
            ...(input.cacheWrite !== undefined ? { cacheWriteTokens: input.cacheWrite } : {}),
            ...(output.reasoning !== undefined ? { reasoningTokens: output.reasoning } : {}),
            ...(input.total !== undefined && output.total !== undefined ? { totalTokens: input.total + output.total } : {}),
          } }
          if (!blocks.size) throw new LlmError('OpenCode returned no content', 'EMPTY_RESPONSE')
          const finish = part.finishReason.unified
          if (finish === 'error' || finish === 'content-filter' || finish === 'other') throw new LlmError(`OpenCode generation ended: ${finish}`, 'PROVIDER_ERROR')
          yield { type: 'finish', reason: { kind: finish === 'tool-calls' ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop' }, replayState: { response: { kind: 'dsh-opencode', version: 1, protocol: descriptor.protocol, provider: options.provider, model: descriptor.id, ...(responseId !== undefined ? { responseId } : {}) }, blocks: [...blocks.values()].map(entry => ({ type: entry.block.type, ...(entry.providerOptions ? { providerOptions: entry.providerOptions } : {}) })) } }
          return
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      if (signal.aborted) throw new LlmError('OpenCode stream idle timeout', 'TIMEOUT')
      if (error instanceof LlmError) throw error
      const raw = record(error); const status = typeof raw?.statusCode === 'number' ? raw.statusCode : undefined; const responseHeaders = record(raw?.responseHeaders)
      const retryHeader = responseHeaders?.['retry-after']; const seconds = Number(retryHeader)
      const retry = typeof retryHeader === 'string' ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now() : undefined
      const requestId = responseHeaders?.['x-request-id'] ?? responseHeaders?.['request-id']
      if (status !== undefined && status >= 200 && status < 300) throw new LlmError(`OpenCode response stream failed after HTTP ${status}`, 'PROTOCOL_ERROR', {status, ...(typeof requestId === 'string' && requestId.trim() ? {requestId: requestId as NonNullable<NonNullable<ConstructorParameters<typeof LlmError>[2]>['requestId']>} : {})})
      throw new LlmError(`OpenCode request failed${status ? `: HTTP ${status}` : ''}`, status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status && status >= 500 ? 'SERVER' : status ? 'PROVIDER_ERROR' : 'TRANSPORT', { ...(status !== undefined ? {status} : {}), ...(retry !== undefined && retry > 0 ? { providerRetryAfterMs: retry } : {}), ...(typeof requestId === 'string' && requestId.trim() ? { requestId: requestId as NonNullable<NonNullable<ConstructorParameters<typeof LlmError>[2]>['requestId']> } : {}) })
    } finally { clearTimeout(timer); abort.abort(); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() } }
  }
}
