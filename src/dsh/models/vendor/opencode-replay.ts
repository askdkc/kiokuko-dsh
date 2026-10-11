/** Versioned history projection. Durable DSH blocks remain authoritative. */
import { LlmError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { OpenCodeModel } from './opencode-catalog.js'
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
export function mergeMetadata(previous: SharedV4ProviderOptions | undefined, next: SharedV4ProviderOptions): SharedV4ProviderOptions {
  const merged = { ...previous }
  for (const [provider, value] of Object.entries(next)) merged[provider] = { ...merged[provider], ...value }
  return merged
}
/** One Responses item can emit multiple summary blocks before its encrypted
 * payload arrives. Share that payload only among blocks of the same item. */
function completeResponseSignatures(blocks: (SharedV4ProviderOptions | undefined)[], content: readonly ContentBlock[]): void {
  const encrypted = new Map<string, string>()
  for (const [index, options] of blocks.entries()) {
    if (content[index]?.type !== 'reasoning') continue
    const item = options?.openai
    if (typeof item?.itemId !== 'string' || typeof item.reasoningEncryptedContent !== 'string' || !item.reasoningEncryptedContent) continue
    const previous = encrypted.get(item.itemId)
    if (previous !== undefined && previous !== item.reasoningEncryptedContent) throw new Error('conflicting reasoning payloads for one response item')
    encrypted.set(item.itemId, item.reasoningEncryptedContent)
  }
  for (const [index, options] of blocks.entries()) {
    const id = options?.openai?.itemId
    if (content[index]?.type === 'reasoning' && typeof id === 'string' && encrypted.has(id)) blocks[index] = mergeMetadata(options, { openai: { reasoningEncryptedContent: encrypted.get(id)! } })
  }
}
const APIS = { messages: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-completions', google: 'google-generative-ai' }
export interface ReplayProjection { blocks: (SharedV4ProviderOptions | undefined)[]; callIds: Map<string, string>; trusted: boolean; foreign: boolean }
/** Validate the entire aligned envelope before restoring any signature or item id. */
export function projectReplay(source: unknown, content: readonly ContentBlock[], model: OpenCodeModel, route: string, warn?: (reason: string) => void): ReplayProjection {
  const message = record(source); const envelope = record(message?.replayState)
  // A model switch deliberately discards provider-specific replay data. It is
  // distinct from a damaged native envelope, whose signature checks still apply.
  const foreign = typeof message?.provider === 'string' && !!message.provider && typeof message.model === 'string' && !!message.model && (message.provider !== route || message.model !== model.id)
  const empty = (): ReplayProjection => ({ blocks: content.map(() => undefined), callIds: new Map(), trusted: false, foreign })
  if (foreign) return empty()
  if (!envelope) { if (message?.replayState !== undefined) warn?.('OpenCode history: malformed replay envelope; retaining message content'); return empty() }
  try {
    const response = record(envelope.response)
    if (!response || response.provider !== message?.provider || response.model !== message?.model) throw new Error('replay identity does not match its message')
    if (message?.provider !== route || message?.model !== model.id) throw new Error('replay belongs to another route or model')
    const owned = response.kind === 'dsh-opencode' && response.version === 1 && response.protocol === model.protocol
    const pi = response.kind === 'pi-ai' && response.version === 2 && response.api === APIS[model.protocol]
    if (pi && !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response.stopReason))) throw new Error('invalid pi replay stop reason')
    if (!owned && !pi) throw new Error('unsupported replay kind, version or protocol')
    if (response.responseId !== undefined && (typeof response.responseId !== 'string' || !response.responseId)) throw new Error('invalid response id')
    if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== content.length) throw new Error('replay block count mismatch')
    const callIds = new Map<string, string>(); const ids = new Set<string>(); const wireIds = new Set<string>()
    const blocks = content.map((block, index): SharedV4ProviderOptions | undefined => {
      const entry = record((envelope.blocks as unknown[])[index])
      if (!entry || entry.type !== block.type) throw new Error('replay block type mismatch')
      if (block.type === 'tool-call') {
        if (!block.id || ids.has(block.id)) throw new Error('duplicate or empty tool call id')
        ids.add(block.id)
      }
      if (owned) {
        if (entry.providerOptions === undefined) return undefined
        const options = record(entry.providerOptions)
        if (!options || Object.values(options).some(value => !record(value))) throw new Error('invalid provider replay options')
        return structuredClone(options) as SharedV4ProviderOptions
      }
      for (const key of ['thinkingSignature', 'thoughtSignature', 'textSignature']) if (entry[key] !== undefined && typeof entry[key] !== 'string') throw new Error('invalid replay signature')
      if (model.protocol === 'messages' && block.type === 'reasoning') {
        if (entry.redacted === true && typeof entry.thinkingSignature === 'string') return { anthropic: { redactedData: entry.thinkingSignature } }
        if (typeof entry.thinkingSignature === 'string' && entry.thinkingSignature) return { anthropic: { signature: entry.thinkingSignature } }
      }
      if (model.protocol === 'google') {
        const signature = entry.thoughtSignature ?? entry.thinkingSignature ?? entry.textSignature
        if (typeof signature === 'string' && signature) return { google: { thoughtSignature: signature } }
      }
      if (model.protocol === 'responses') {
        if (block.type === 'reasoning' && typeof entry.thinkingSignature === 'string') {
          const item = record(JSON.parse(entry.thinkingSignature))
          if (item?.type !== 'reasoning' || typeof item.id !== 'string' || typeof item.encrypted_content !== 'string' || !item.encrypted_content) throw new Error('Responses reasoning has no restorable encrypted payload')
          return { openai: { itemId: item.id, reasoningEncryptedContent: item.encrypted_content } }
        }
        if (block.type === 'text' && typeof entry.textSignature === 'string') {
          if (!entry.textSignature.startsWith('{')) return { openai: { itemId: entry.textSignature } }
          const signature = record(JSON.parse(entry.textSignature))
          if (signature?.v !== 1 || typeof signature.id !== 'string') throw new Error('unknown Responses text signature')
          return { openai: { itemId: signature.id, ...(signature.phase === 'commentary' || signature.phase === 'final_answer' ? { phase: signature.phase } : {}) } }
        }
        if (block.type === 'tool-call') {
          const pieces = block.id.split('|')
          if (pieces.length > 2 || !pieces[0] || (pieces.length === 2 && !pieces[1])) throw new Error('invalid Responses tool call pairing')
          if (wireIds.has(pieces[0]!)) throw new Error('duplicate Responses wire call id')
          wireIds.add(pieces[0]!)
          callIds.set(block.id, pieces[0]!)
          if (pieces[1]) return { openai: { itemId: pieces[1] } }
        }
      }
      return undefined
    })
    if (model.protocol === 'responses') completeResponseSignatures(blocks, content)
    return { blocks, callIds, trusted: true, foreign: false }
  } catch (error) {
    warn?.(`OpenCode history: ${error instanceof Error ? error.message : 'invalid replay'}; retaining message content`)
    return empty()
  }
}
/** Mandatory signatures cannot be replaced by SDK sentinel values or silently omitted. */
export function requireReplaySignature(block: ContentBlock, protocol: OpenCodeModel['protocol'], options: SharedV4ProviderOptions | undefined): void {
  if (block.type !== 'reasoning') return
  const native = options?.[protocol === 'messages' ? 'anthropic' : 'openai']
  if (protocol === 'messages' && !native?.signature && !native?.redactedData) throw new LlmError('Cannot replay Anthropic reasoning without its verified signature', 'INVALID_REPLAY_STATE')
  if (protocol === 'responses' && !native?.reasoningEncryptedContent) throw new LlmError('Cannot replay Responses reasoning without its verified encrypted payload', 'INVALID_REPLAY_STATE')
}
