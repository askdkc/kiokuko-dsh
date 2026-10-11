/** Convert DSH conversation blocks into low-level SDK prompts without an agent loop. */
import { LlmError, projectToolUpdates, fileHandleText, type GenerateOptions, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { OpenCodeModel } from './opencode-catalog.js'
import { projectReplay, requireReplaySignature } from './opencode-replay.js'
import { createHash } from 'node:crypto'
export async function encodePrompt(options: GenerateOptions, model: OpenCodeModel, attachments?: () => AttachmentStore | undefined, warn?: (reason: string) => void): Promise<LanguageModelV4Prompt> {
    const prompt: LanguageModelV4Prompt = []; const names = new Map<string, string>(); const callIds = new Map<string, string>(); const wireIds = new Set<string>()
    if (options.system) prompt.push({ role: 'system', content: options.system })
    const projection = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
    let imageBytes = 0
    const imagePart = async (block: Extract<ContentBlock, { type: 'image' }>) => {
      if (block.offloaded || !model.inputModalities.includes('image')) return { type: 'text' as const, text: '[image omitted from this request]' }
      const store = attachments?.(); if (!store) throw new LlmError('Image attachment service unavailable', 'ATTACHMENT_UNAVAILABLE')
      const { requestImageDimensions } = await import('@deepseek-ai/dsh-attachment')
      const image = await store.readImageRequest(block.attachment, { ...requestImageDimensions(block.attachment.width, block.attachment.height, 4_194_304), maxBytes: 1024 * 1024 }, options.signal)
      imageBytes += Math.ceil(image.bytes / 3) * 4
      if (imageBytes > 20 * 1024 * 1024) throw new LlmError('Image request exceeds 20 MiB', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: 1 })
      return { type: 'file' as const, mediaType: image.mediaType, data: { type: 'data' as const, data: image.data } }
    }
    for (const message of projection.messages) {
      if (message.role === 'system') { prompt.push({ role: 'system', content: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }); continue }
      if (message.role === 'developer') {
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (text) prompt.push({ role: 'system', content: text })
        continue
      }
      if (message.role === 'tool') {
        const toolName = names.get(message.toolCallId)
        if (!toolName) throw new LlmError('Stored tool result has no matching call', 'INVALID_REPLAY_STATE')
        const parts = []
        for (const block of message.content) {
          if (block.type === 'text') parts.push({ type: 'text' as const, text: block.text })
          else if (block.type === 'file') parts.push({ type: 'text' as const, text: fileHandleText(block.attachment, attachments?.()?.fileHostPath(block.attachment)) })
          else if (block.type === 'image') parts.push(await imagePart(block))
        }
        prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callIds.get(message.toolCallId) ?? message.toolCallId, toolName,
          output: message.isError ? { type: 'error-text', value: parts.map(part => part.type === 'text' ? part.text : '[image]').join('\n') } : { type: 'content', value: parts } }] }); continue
      }
      const content: Extract<LanguageModelV4Prompt[number], { role: 'assistant' }>['content'] = []
      const replay = projectReplay('source' in message ? message.source : undefined, message.content, model, options.provider, warn)
      for (const [original, wire] of replay.callIds) callIds.set(original, wire)
      for (const [index, block] of message.content.entries()) {
        const providerOptions = replay.blocks[index]
        if (block.type === 'text') content.push({ type: 'text', text: block.text, ...(providerOptions ? {providerOptions} : {}) })
        else if (block.type === 'file') content.push({ type: 'text', text: fileHandleText(block.attachment, attachments?.()?.fileHostPath(block.attachment)) })
        else if (block.type === 'reasoning' && message.role === 'assistant') {
          if (replay.foreign) continue
          requireReplaySignature(block, model.protocol, providerOptions)
          content.push({ type: 'reasoning', text: block.text, ...(providerOptions ? {providerOptions} : {}) })
        } else if (block.type === 'tool-call' && message.role === 'assistant') {
          // Foreign pi Responses ids contain an opaque item suffix. Give the
          // call/result pair a portable id without restoring that foreign item.
          if (replay.foreign && model.protocol === 'responses' && block.id.includes('|')) callIds.set(block.id, `dsh_${createHash('sha256').update(block.id).digest('hex').slice(0, 48)}`)
          if (model.protocol === 'responses' && block.id.includes('|') && !callIds.has(block.id)) throw new LlmError('Cannot restore legacy Responses tool call pairing', 'INVALID_REPLAY_STATE')
          if (names.has(block.id)) throw new LlmError('Duplicate stored tool call id', 'INVALID_REPLAY_STATE')
          const wireId = callIds.get(block.id) ?? block.id
          if (wireIds.has(wireId)) throw new LlmError('Duplicate wire tool call id', 'INVALID_REPLAY_STATE')
          wireIds.add(wireId)
          if (model.protocol === 'google' && model.reasoning && !providerOptions?.google?.thoughtSignature && !message.content.slice(0, index).some(part => part.type === 'tool-call')) throw new LlmError('Cannot replay Google tool call without its verified thought signature', 'INVALID_REPLAY_STATE')
          names.set(block.id, block.name); let input: unknown
          try { input = JSON.parse(block.arguments) } catch { throw new LlmError('Stored tool arguments are not valid JSON', 'INVALID_REPLAY_STATE') }
          content.push({ type: 'tool-call', toolCallId: wireId, toolName: block.name, input, ...(providerOptions ? {providerOptions} : {}) })
        } else if (block.type === 'image') {
          if (message.role === 'assistant') throw new LlmError('Structured assistant image output is unsupported', 'UNSUPPORTED_CONTENT')
          content.push(await imagePart(block))
        }
      }
      if (content.length || !replay.foreign) prompt.push({ role: message.role, content } as LanguageModelV4Prompt[number])
    }
    return prompt
}
