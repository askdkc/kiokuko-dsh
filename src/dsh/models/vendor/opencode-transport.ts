/** Protocol SDKs serialize the wire; the owned descriptor controls model settings. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { createAnthropic, createOpenAI, createGoogleGenerativeAI, createOpenAICompatible } from './opencode-sdk.js'
import { OPEN_CODE_URLS, type OpenCodeModel, type OpenCodeRoute } from './opencode-catalog.js'
export function createTransport(descriptor: OpenCodeModel, options: GenerateOptions, apiKey: string, headers: Record<string, string>, prompt: LanguageModelV4Prompt, fetcher: typeof fetch = fetch): LanguageModelV4 {
  const baseURL = OPEN_CODE_URLS[options.provider as OpenCodeRoute]
  if (!baseURL) throw new Error('Unknown OpenCode route')
  const fixedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!new URL(url).href.startsWith(`${baseURL}/`)) throw new Error('OpenCode SDK attempted to leave its fixed route')
    // SDK serializers keep their protocol codecs; all model settings come
    // from our descriptor, overriding any SDK id-based limits or enums.
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body)
      const effort = descriptor.reasoning ? options.reasoningEffort : undefined
      const maxTokens = options.maxTokens ?? descriptor.maxTokens
      const sampling = descriptor.protocol === 'google' ? (body.generationConfig ??= {}) : body
      if (descriptor.temperature && options.temperature !== undefined) sampling.temperature = options.temperature
      else delete sampling.temperature
      switch (descriptor.protocol) {
        case 'messages':
          body.max_tokens = maxTokens
          // Effort works independently of thinking. Do not invent an
          // adaptive mode or budget for models advertising only effort.
          // https://platform.claude.com/docs/en/build-with-claude/effort
          if (effort) body.output_config = { ...body.output_config, effort }
          break
        case 'responses': {
          body.store = false
          const ids = new Map(prompt.flatMap(message => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'tool-call' && typeof part.providerOptions?.openai?.itemId === 'string' ? [[part.toolCallId, part.providerOptions.openai.itemId] as const] : []) : []))
          for (const item of body.input ?? []) if (item.type === 'function_call' && ids.has(item.call_id)) item.id = ids.get(item.call_id)
          body.max_output_tokens = maxTokens
          if (descriptor.reasoning) {
            body.include = [...new Set([...(body.include ?? []), 'reasoning.encrypted_content'])]
            if (effort) body.reasoning = { effort }
          } else delete body.reasoning
          break
        }
        case 'chat':
          body.max_tokens = maxTokens
          if (effort) body.reasoning_effort = effort
          break
        case 'google':
          sampling.maxOutputTokens = maxTokens
          if (effort) sampling.thinkingConfig = { ...sampling.thinkingConfig, thinkingLevel: effort, includeThoughts: true }
          break
      }
      init = { ...init, body: JSON.stringify(body) }
    }
    return fetcher(input, { ...init, redirect: 'error' })
  }
  const settings = { baseURL, apiKey, headers, fetch: fixedFetch }
  switch (descriptor.protocol) {
    case 'messages': return createAnthropic(settings)(descriptor.id)
    case 'responses': return createOpenAI(settings).responses(descriptor.id)
    case 'google': return createGoogleGenerativeAI(settings)(descriptor.id)
    case 'chat': return createOpenAICompatible({ ...settings, name: 'opencode' })(descriptor.id)
  }
}
