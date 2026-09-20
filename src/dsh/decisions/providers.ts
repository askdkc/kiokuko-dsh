import { z } from 'zod'
import { abortable, readBoundedJson } from '../http-json.js'
import { DECISION_BYTES, DecisionError, parseDecisionBatch, parseDecisionResult, type DecisionProvider, type DecisionBatch, type DecisionBatchResult } from './contracts.js'
import { decisionEndpoint, type DecisionConfiguration } from './config.js'

const probability = z.number().finite().min(0).max(1)
const responseSchema = z.object({ model: z.string().min(1).max(256).optional(),
  answers: z.record(z.string(), z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), probability), confidence: probability }).strict()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict().optional(),
}).strict()
export const POLICY_VERSION = 'finite-choice-v1'
export const TYPESAFE_LIMITS = Object.freeze({ maxQuestions: 64, maxChoices: 256, maxBytes: DECISION_BYTES })
export const NIMBLE_LIMITS = Object.freeze({ maxQuestions: 64, maxChoices: 26, maxBytes: DECISION_BYTES, maxPromptTokens: 2048 })

/** Serialize from ordered arrays; even numeric-looking IDs must retain caller order. */
export function choiceBody(batch: DecisionBatch, model: string): string {
  const questions = batch.questions.map(q => `${JSON.stringify(q.id)}:{"type":"choice","instructions":${JSON.stringify(q.instructions)},"criteria":{${q.choices.map(c => `${JSON.stringify(c.id)}:${JSON.stringify(c.description)}`).join(',')}}}`).join(',')
  return `{"state":${JSON.stringify(batch.state)},"model":${JSON.stringify(model)},"questions":{${questions}}}`
}
function decode(value: unknown, batch: DecisionBatch, provider: string, model: string, accept: (confidence: number, top: number, runnerUp: number) => boolean): DecisionBatchResult {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) throw new DecisionError('MALFORMED_RESPONSE')
  const response = parsed.data
  if (Object.keys(response.answers).length !== batch.questions.length) throw new DecisionError('MALFORMED_RESPONSE')
  const answers = batch.questions.map(q => {
    const a = response.answers[q.id]
    if (!a || Object.keys(a.probabilities).length !== q.choices.length || q.choices.some(c => !Object.hasOwn(a.probabilities, c.id))
      || !q.choices.some(c => c.id === a.choice) || Math.abs(Object.values(a.probabilities).reduce((n, p) => n + p, 0) - 1) > .001) throw new DecisionError('MALFORMED_RESPONSE')
    const ranked = Object.values(a.probabilities).sort((a, b) => b - a)
    const top = ranked[0]!, runnerUp = ranked[1]!
    if (a.probabilities[a.choice] !== top) throw new DecisionError('MALFORMED_RESPONSE')
    if (a.choice === q.abstainId) return { id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }
    if (top === runnerUp) return { id: q.id, status: 'abstained' as const, reason: 'tie' as const }
    if (!accept(a.confidence, top, runnerUp)) return { id: q.id, status: 'abstained' as const, reason: 'uncertain' as const }
    return { id: q.id, status: 'selected' as const, choiceId: a.choice }
  })
  return parseDecisionResult({ answers, provider, requestedModel: model, ...(response.model ? { returnedModel: response.model } : {}), policyVersion: POLICY_VERSION,
    ...(response.usage ? { usage: response.usage } : {}) }, batch)
}
interface HttpSettings { endpoint: string; model: string; credential: () => Promise<string | undefined>; request?: typeof fetch }
async function evaluateHttp(settings: HttpSettings, batch: DecisionBatch, signal: AbortSignal, mapStatus: (status: number) => DecisionError): Promise<unknown> {
  const body = choiceBody(parseDecisionBatch(batch), settings.model)
  if (Buffer.byteLength(body) > DECISION_BYTES) throw new DecisionError('TOO_LARGE')
  try {
    signal.throwIfAborted()
    const credential = await abortable(settings.credential(), signal)
    if (credential !== undefined && (!credential || credential.length > 4096 || !/^[\x21-\x7e]+$/.test(credential))) throw new DecisionError('AUTH')
    signal.throwIfAborted()
    const pending = (settings.request ?? fetch)(settings.endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body })
    void pending.then(r => { if (signal.aborted) void r.body?.cancel().catch(() => {}) }, () => {})
    const response = await abortable(pending, signal)
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw mapStatus(response.status) }
    const value = await readBoundedJson(response, signal, DECISION_BYTES, k => new DecisionError(k === 'large' ? 'TOO_LARGE' : 'MALFORMED_RESPONSE'))
    signal.throwIfAborted()
    if (credential && JSON.stringify(value).includes(credential)) throw new DecisionError('MALFORMED_RESPONSE')
    return value
  } catch (error) {
    if (signal.aborted) throw new DecisionError('CANCELLED')
    throw error instanceof DecisionError ? error : new DecisionError('UNAVAILABLE')
  }
}
export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly capabilities = TYPESAFE_LIMITS
  constructor(private readonly config: DecisionConfiguration['typesafe'], private readonly credential: () => Promise<string>, private readonly request: typeof fetch = fetch) {}
  async evaluate(batch: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult> {
    const value = await evaluateHttp({ endpoint: 'https://api.typesafe.ai/v1/systemone', model: this.config.model, credential: this.credential, request: this.request }, batch, signal,
      s => new DecisionError(s === 401 || s === 403 ? 'AUTH' : s === 413 ? 'TOO_LARGE' : s === 422 ? 'INVALID_INPUT' : 'UNAVAILABLE'))
    return decode(value, batch, 'typesafe', this.config.model, confidence => confidence >= this.config.acceptance.minConfidence)
  }
}
export class NimbleDecisionProvider implements DecisionProvider {
  readonly capabilities = NIMBLE_LIMITS
  constructor(private readonly config: DecisionConfiguration['nimble'], private readonly credential: () => Promise<string | undefined>, private readonly request: typeof fetch = fetch) {}
  async evaluate(batch: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult> {
    if (!this.config.endpoint || !this.config.model) throw new DecisionError('UNAVAILABLE')
    if (batch.questions.length > 64 || batch.questions.some(q => q.choices.length > 26)) throw new DecisionError('TOO_LARGE')
    const value = await evaluateHttp({ endpoint: decisionEndpoint(this.config.endpoint), model: this.config.model, credential: this.credential, request: this.request }, batch, signal,
      s => new DecisionError(s === 401 || s === 403 ? 'AUTH' : s === 413 || s === 422 ? 'TOO_LARGE' : s === 504 ? 'TIMEOUT' : s === 499 ? 'CANCELLED' : 'UNAVAILABLE'))
    // Nimble confidence is entropy-derived. Acceptance uses selected probability and margin instead.
    return decode(value, batch, 'nimble', this.config.model!, (_confidence, top, runnerUp) => top >= this.config.acceptance.minProbability && top - runnerUp >= this.config.acceptance.minMargin)
  }
}
