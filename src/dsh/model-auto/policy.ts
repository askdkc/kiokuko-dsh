import { ModelBindingSchema, type ModelBinding } from '../model-configuration.js'

export function projectModelBinding(value: unknown): ModelBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const parsed = ModelBindingSchema.safeParse({ provider: record.provider, model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }) })
  return parsed.success ? parsed.data : undefined
}

/** Project kinds only; bytes and attachment contents remain in the native request. */
export function attachmentTypesFromMessages(messages: readonly unknown[]): string[] {
  const kinds = new Set<string>()
  for (const value of messages) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    const source = message.source as { kind?: unknown } | undefined
    if (source?.kind !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const type = (block as { type?: unknown }).type
      if (type === 'image' || type === 'image-url') kinds.add('image')
      else if (type !== 'text') kinds.add('unsupported')
    }
  }
  return [...kinds].sort()
}

export function nativeContextTokens(host: { get(name: string, strict?: boolean): unknown }, session: unknown): number | undefined {
  const meter = host.get('tokenMeter', false) as { measure?: (session: unknown, header?: unknown) => { totalTokens?: unknown } } | undefined
  if (!meter?.measure || !session || typeof session !== 'object') return undefined
  try {
    const native = session as { requestHeader?: () => unknown }
    const value = meter.measure(session, native.requestHeader?.()).totalTokens
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch { return undefined }
}
