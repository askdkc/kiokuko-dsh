import { z } from 'zod'
import { canonicalJson } from '../../serialization/validate.js'
import { LAYA_MODELS, LAYA_POLICY_VERSION, TypedDecisionsConfig, resolveDecisionConfiguration, type DecisionConfiguration, type LayaSettings } from './config.js'
import { DECISION_BYTES, DecisionError, parseDecisionBatch, parseDecisionResult, requireChoice, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'
import { requestLaya, type LayaTransport } from './laya-transport.js'

const probability = z.number().finite().min(0).max(1)
const runtimeSchema = z.object({
  model: z.enum(['aac6fef/laya-multilingual-coreml', 'aac6fef/laya-multilingual-coreml-ane']),
  runtimeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  limits: z.object({ maxQuestions: z.literal(1), maxChoices: z.literal(32), maxBytes: z.literal(DECISION_BYTES), maxPromptTokens: z.number().int().positive() }).strict(),
}).strict()
const usageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.literal(0) }).strict()
const resultSchema = z.object({ model: z.literal('laya-rl-agent'),
  answers: z.record(z.string(), z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(z.string(), probability),
    confidence: probability, action: z.object({ act_probability: probability }).strict() }).strict()), usage: usageSchema,
}).strict()
const successSchema = z.object({ version: z.literal(1), ok: z.literal(true), runtime: runtimeSchema, result: resultSchema,
  server: z.object({ predict_ms: z.number().finite().nonnegative() }).strict(),
}).strict()
const preflightSchema = z.object({ version: z.literal(1), ok: z.literal(true), runtime: runtimeSchema, input_tokens: z.number().int().positive() }).strict()
const errorSchema = z.object({ version: z.literal(1), ok: z.literal(false), error: z.object({ code: z.string().max(80), message: z.string().max(1024).optional() }).strict() }).strict()

export function workerError(value: unknown): void {
  const error = errorSchema.safeParse(value)
  if (!error.success) return
  const code = error.data.error.code
  if (code === 'too_large') throw new DecisionError('TOO_LARGE')
  if (['invalid_request', 'invalid_state', 'invalid_questions', 'invalid_input', 'reserved_token'].includes(code)) throw new DecisionError('INVALID_INPUT')
  if (['unsupported_version', 'invalid_operation', 'unsupported', 'runtime_mismatch'].includes(code)) throw new DecisionError('UNSUPPORTED')
  if (code === 'timeout') throw new DecisionError('TIMEOUT')
  throw new DecisionError('UNAVAILABLE')
}

/** The original start-laya worker exposes health/predict without strict runtime metadata. */
export function parseLayaV1Health(value: unknown): void {
  workerError(value)
  if (!z.object({ version: z.literal(1), ok: z.literal(true), status: z.literal('ready') }).safeParse(value).success) throw new DecisionError('UNSUPPORTED')
}

/** Accept only a worker advertising both strict operations; legacy v1 is unsupported. */
export function parseLayaHealth(value: unknown) {
  workerError(value)
  const parsed = z.object({ version: z.literal(1), ok: z.literal(true), status: z.literal('ready'),
    operations: z.array(z.string()), runtime: runtimeSchema }).safeParse(value)
  if (!parsed.success || !['preflight', 'predict_strict'].every(op => parsed.data.operations.includes(op))
    || parsed.data.runtime.limits.maxPromptTokens !== LAYA_MODELS[parsed.data.runtime.model]) throw new DecisionError('UNSUPPORTED')
  return parsed.data.runtime
}

/** Discover missing runtime identity without evidence or inference; explicit pins remain constraints. */
export async function discoverLayaConfiguration(config: DecisionConfiguration, repositoryRoot: string, signal: AbortSignal, request: LayaTransport = requestLaya): Promise<DecisionConfiguration> {
  if (config.provider !== 'laya-coreml' || config.mode === 'off') return structuredClone(config)
  const resolved = resolveDecisionConfiguration(TypedDecisionsConfig.parse({ ...config, 'laya-coreml': config['laya-coreml'] ?? {} }), repositoryRoot)
  const settings = resolved['laya-coreml']!
  const health = await request(settings.socketPath, '{"version":1,"op":"health"}', signal, settings.timeoutMs)
  parseLayaV1Health(health)
  const operations = (health as { operations?: unknown }).operations
  const strict = Array.isArray(operations) && ['preflight', 'predict_strict'].every(op => operations.includes(op))
  // An existing strict binding never downgrades. Plain v1 needs no worker update or invented fingerprint.
  if (!settings.runtimeFingerprint && (settings.protocol === 'v1' || !strict)) {
    if (settings.model && settings.model !== 'laya-rl-agent') throw new DecisionError('UNSUPPORTED')
    return { ...resolved, 'laya-coreml': { ...settings, protocol: 'v1', model: 'laya-rl-agent' } }
  }
  const runtime = parseLayaHealth(health)
  if (settings.model && settings.model !== runtime.model || settings.runtimeFingerprint && settings.runtimeFingerprint !== runtime.runtimeFingerprint) throw new DecisionError('UNSUPPORTED')
  return { ...resolved, 'laya-coreml': { ...settings, model: runtime.model, runtimeFingerprint: runtime.runtimeFingerprint } }
}

/** Construct ordered object members directly; JSON.stringify(object) reorders integer-like IDs. */
export function layaRequestBody(op: 'predict' | 'preflight' | 'predict_strict', batch: DecisionBatch, settings: LayaSettings, budgetMs: number): string {
  const state = typeof batch.state === 'string' ? batch.state : canonicalJson(batch.state)
  const questions = batch.questions.map(question => { const q = requireChoice(question); return `${JSON.stringify(q.id)}:{"type":"choice","instructions":${JSON.stringify(q.instructions)},"criteria":{${q.choices.map(c => `${JSON.stringify(c.id)}:${JSON.stringify(c.description)}`).join(',')}}}` }).join(',')
  const runtime = op === 'predict' ? '' : `,"model":${JSON.stringify(settings.model)},"expectedRuntimeFingerprint":${JSON.stringify(settings.runtimeFingerprint)},"budgetMs":${budgetMs}`
  return `{"version":1,"op":${JSON.stringify(op)}${runtime},"state":${JSON.stringify(state)},"questions":{${questions}}}`
}

export class LayaCoreMLDecisionProvider implements DecisionProvider {
  readonly capabilities
  private verified = false
  constructor(private readonly settings: LayaSettings | undefined, private readonly request: LayaTransport = requestLaya) {
    this.capabilities = Object.freeze({ maxQuestions: 1, maxChoices: 32, maxBytes: DECISION_BYTES,
      ...(settings?.model && settings.model !== 'laya-rl-agent' ? { maxPromptTokens: LAYA_MODELS[settings.model] } : {}) })
  }
  private checkRuntime(runtime: z.infer<typeof runtimeSchema>): void {
    if (runtime.model !== this.settings?.model || runtime.runtimeFingerprint !== this.settings.runtimeFingerprint
      || runtime.limits.maxPromptTokens !== this.capabilities.maxPromptTokens) throw new DecisionError('UNSUPPORTED')
  }
  private async call(op: 'preflight' | 'predict_strict', input: DecisionBatch, signal: AbortSignal): Promise<unknown> {
    const batch = parseDecisionBatch(input), settings = this.settings
    if (signal.aborted) throw new DecisionError('CANCELLED')
    if (!settings?.model || !settings.runtimeFingerprint) throw new DecisionError('UNAVAILABLE')
    if (batch.questions.length > 1 || batch.questions.some(q => requireChoice(q).choices.length > 32)) throw new DecisionError('TOO_LARGE')
    const deadline = performance.now() + settings.timeoutMs
    // Validate the complete envelope before even a health request.
    if (Buffer.byteLength(layaRequestBody(op, batch, settings, settings.timeoutMs)) > DECISION_BYTES) throw new DecisionError('TOO_LARGE')
    if (!this.verified) {
      const health = await this.request(settings.socketPath, '{"version":1,"op":"health"}', signal, settings.timeoutMs)
      this.checkRuntime(parseLayaHealth(health))
      this.verified = true
    }
    if (signal.aborted) throw new DecisionError('CANCELLED')
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new DecisionError('TIMEOUT')
    const value = await this.request(settings.socketPath, layaRequestBody(op, batch, settings, remaining), signal, remaining)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    workerError(value)
    return value
  }
  async preflight(batch: DecisionBatch, signal: AbortSignal): Promise<void> {
    const parsed = preflightSchema.safeParse(await this.call('preflight', batch, signal))
    if (!parsed.success) throw new DecisionError('MALFORMED_RESPONSE')
    this.checkRuntime(parsed.data.runtime)
    if (parsed.data.input_tokens > this.capabilities.maxPromptTokens!) throw new DecisionError('MALFORMED_RESPONSE')
  }
  async evaluate(batch: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult> {
    const parsed = successSchema.safeParse(await this.call('predict_strict', batch, signal))
    if (!parsed.success) throw new DecisionError('MALFORMED_RESPONSE')
    const { runtime, result } = parsed.data
    this.checkRuntime(runtime)
    if (result.usage.input_tokens < 1 || result.usage.input_tokens > runtime.limits.maxPromptTokens
      || Object.keys(result.answers).length !== batch.questions.length) throw new DecisionError('MALFORMED_RESPONSE')
    const { answers } = decodeLayaResult(result, batch, this.settings!)
    return parseDecisionResult({ answers, provider: 'laya-coreml', requestedModel: this.settings!.model, returnedModel: runtime.model,
      revision: runtime.runtimeFingerprint, policyVersion: LAYA_POLICY_VERSION, usage: result.usage }, batch)
  }
}

/** Validate the same finite-choice result contract for both worker protocols. */
export function decodeLayaResult(value: unknown, batch: DecisionBatch, settings: LayaSettings) {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success || parsed.data.usage.input_tokens < 1 || Object.keys(parsed.data.answers).length !== batch.questions.length) throw new DecisionError('MALFORMED_RESPONSE')
  const result = parsed.data
  const answers = batch.questions.map(question => { const q = requireChoice(question)
    const answer = result.answers[q.id]
    if (!answer || Object.keys(answer.probabilities).length !== q.choices.length || !Object.hasOwn(answer.probabilities, answer.choice)
      || q.choices.some(c => !Object.hasOwn(answer.probabilities, c.id))) throw new DecisionError('MALFORMED_RESPONSE')
    const probabilities = q.choices.map(c => answer.probabilities[c.id]!)
    if (Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > q.choices.length * 0.00005 + 1e-12) throw new DecisionError('MALFORMED_RESPONSE')
    const [top, runnerUp] = probabilities.sort((a, b) => b - a) as [number, number, ...number[]]
    if (answer.probabilities[answer.choice] !== top) throw new DecisionError('MALFORMED_RESPONSE')
    if (answer.choice === q.abstainId) return { id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }
    if (top === runnerUp) return { id: q.id, status: 'abstained' as const, reason: 'tie' as const }
    const acceptance = settings.acceptance
    if (top - 0.00005 < acceptance.minProbability || top - runnerUp - 0.0001 < acceptance.minMargin) return { id: q.id, status: 'abstained' as const, reason: 'uncertain' as const }
    return { id: q.id, status: 'selected' as const, choiceId: answer.choice }
  })
  return { answers, usage: result.usage }
}
