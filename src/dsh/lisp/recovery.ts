import { z } from 'zod'
import { parseDecisionBatch } from '../decisions/contracts.js'
import { fail, identifier, LispError } from './contracts.js'
import type { LispRpcContext } from './worker.js'

const Request = z.object({ ticket: identifier, condition: z.string().min(1).max(256), context: z.unknown(),
  restarts: z.array(z.object({ id: identifier, description: z.string().min(1).max(1024) }).strict()).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(30000) }).strict()

/** One evaluation's bounded continuation choices. No code, arguments, or replay. */
export class LispRecoverySession {
  readonly #used = new Set<string>()
  constructor(readonly generation: string, readonly evaluationId: string) {}
  async select(input: unknown, context: LispRpcContext,
    evaluate: (batch: unknown, context: LispRpcContext) => Promise<unknown>,
    assertCurrent: () => Promise<void>): Promise<{ ticket: string; restartId: string }> {
    const request = Request.parse(input)
    if (context.generation !== this.generation || context.evaluationId !== this.evaluationId ||
      !request.ticket.startsWith(`${this.generation}/${this.evaluationId}/`)) fail('RECOVERY_STALE', 'Recovery belongs to another evaluation.')
    if (this.#used.has(request.ticket)) fail('RECOVERY_CONSUMED', 'Recovery choice was already consumed.')
    if (this.#used.size >= 4) fail('RECOVERY_LIMIT', 'At most four recovery choices per evaluation.')
    if (request.restarts.some((r, i) => r.id !== `${request.ticket}/${i}`)) fail('RECOVERY_STALE', 'Restart identity is not current.')
    const batch = parseDecisionBatch({ purpose: 'lisp', state: { condition: request.condition, context: request.context },
      questions: [{ id: request.ticket, instructions: 'Choose one explicitly offered continuation supported by the supplied state. Never replay the expression. Abstain if safety or the result of an effect is uncertain.',
        choices: [...request.restarts, { id: `${request.ticket}/abort`, description: 'Abort recovery; insufficient evidence or unsafe continuation.' }], abstainId: `${request.ticket}/abort` }] })
    context.signal.throwIfAborted()
    this.#used.add(request.ticket) // claim synchronously, including failed/abstained attempts
    await assertCurrent()
    context.signal.throwIfAborted()
    const deadline = AbortSignal.timeout(request.timeoutMs)
    const signal = AbortSignal.any([context.signal, deadline])
    let onAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new LispError(deadline.aborted ? 'RECOVERY_TIMEOUT' : 'RECOVERY_CANCELLED', 'Recovery selection ended without a continuation.'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      const response = await Promise.race([evaluate(batch, { ...context, signal }), cancelled]) as {
        status?: string; result?: { answers?: { id?: string; status?: string; choiceId?: string }[] }
      } | undefined
      signal.throwIfAborted()
      await assertCurrent()
      signal.throwIfAborted()
      const answers = response?.result?.answers, answer = answers?.[0]
      if (response?.status !== 'completed' || answers?.length !== 1 || answer?.id !== request.ticket ||
        answer.status !== 'selected' || !request.restarts.some(r => r.id === answer.choiceId))
        fail('RECOVERY_DECLINED', 'No current, explicit restart was selected.')
      return { ticket: request.ticket, restartId: answer.choiceId! }
    } finally { signal.removeEventListener('abort', onAbort) }
  }
}
