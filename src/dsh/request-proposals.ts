import { canonicalContentHash } from '../serialization/validate.js'
import { findSecret } from '../memory/secrets.js'
import type { RequestIntentContext } from './decisions/request-intent.js'

/** Same-session native proposals are evidence, never user approval. */
export function nativeRequestProposals(
  events: readonly { type: string; seq?: number; data?: unknown }[],
  turn: number,
  sessionId: string,
): RequestIntentContext['proposals'] {
  const proposals: RequestIntentContext['proposals'] = []
  let assistantText: RequestIntentContext['proposals'][number] | undefined
  for (const event of [...events].reverse()) {
    if (
      event.type !== 'assistant/message' ||
      !event.data ||
      typeof event.data !== 'object'
    )
      continue
    const data = event.data as {
      turn?: number
      message?: unknown
      role?: unknown
      content?: unknown
      id?: unknown
    }
    if (!Number.isSafeInteger(data.turn) || data.turn! >= turn) continue
    const message = (data.message ?? data) as {
      role?: unknown
      content?: unknown
      id?: unknown
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
      continue
    const messageId =
      typeof message.id === 'string' ? message.id : `seq:${event.seq}`
    const text = message.content
      .filter(
        (block) => block?.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (
      !assistantText &&
      text &&
      text.length <= 8192 &&
      findSecret(text) === undefined
    ) {
      assistantText = {
        id: `assistant-${canonicalContentHash([sessionId, messageId])}`,
        revision: null,
        digest: canonicalContentHash(text),
        text,
      }
    }
    const call = message.content.find(
      (block) => block?.type === 'tool-call' && block.name === 'exit_plan_mode',
    )
    if (!call) continue
    let args: unknown = call.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    const plan =
      args && typeof args === 'object'
        ? (args as { plan?: unknown }).plan
        : undefined
    if (
      typeof plan !== 'string' ||
      !plan.trim() ||
      plan.length > 8192 ||
      findSecret(plan) !== undefined
    )
      continue
    proposals.push({
      id: `plan-${canonicalContentHash([sessionId, messageId, call.id])}`,
      revision: null,
      digest: canonicalContentHash(plan),
      text: plan,
    })
    break
  }
  if (assistantText) proposals.push(assistantText)
  return proposals
}
