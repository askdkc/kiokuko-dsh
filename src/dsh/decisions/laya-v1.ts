import { z } from 'zod'
import { DECISION_BYTES, DecisionError, parseDecisionBatch, parseDecisionResult, type DecisionBatch, type DecisionBatchResult, type DecisionProvider } from './contracts.js'
import { LAYA_POLICY_VERSION, type LayaSettings } from './config.js'
import { decodeLayaResult, layaRequestBody, parseLayaV1Health, workerError } from './laya-coreml.js'
import { requestLaya, type LayaTransport } from './laya-transport.js'

const responseSchema = z.object({ version: z.literal(1), ok: z.literal(true), result: z.unknown(),
  server: z.object({ predict_ms: z.number().finite().nonnegative() }) })

/** Direct client for an already running start-laya worker. No claimed preflight or runtime fingerprint. */
export class LayaV1DecisionProvider implements DecisionProvider {
  readonly capabilities = Object.freeze({ maxQuestions: 1, maxChoices: 32, maxBytes: DECISION_BYTES })
  constructor(private readonly settings: LayaSettings, private readonly request: LayaTransport = requestLaya) {}

  async evaluate(input: DecisionBatch, signal: AbortSignal): Promise<DecisionBatchResult> {
    const batch = parseDecisionBatch(input)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    if (this.settings.protocol !== 'v1' || this.settings.model !== 'laya-rl-agent' || this.settings.runtimeFingerprint) throw new DecisionError('UNSUPPORTED')
    if (batch.questions.length !== 1 || batch.questions.some(q => q.choices.length > this.capabilities.maxChoices)) throw new DecisionError('TOO_LARGE')
    const body = layaRequestBody('predict', batch, this.settings, this.settings.timeoutMs)
    if (Buffer.byteLength(body) > DECISION_BYTES) throw new DecisionError('TOO_LARGE')
    const deadline = performance.now() + this.settings.timeoutMs
    parseLayaV1Health(await this.request(this.settings.socketPath, '{"version":1,"op":"health"}', signal, this.settings.timeoutMs))
    if (signal.aborted) throw new DecisionError('CANCELLED')
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) throw new DecisionError('TIMEOUT')
    const value = await this.request(this.settings.socketPath, body, signal, remaining)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    workerError(value)
    const parsed = responseSchema.safeParse(value)
    if (!parsed.success) throw new DecisionError('MALFORMED_RESPONSE')
    const decoded = decodeLayaResult(parsed.data.result, batch, this.settings)
    return parseDecisionResult({ ...decoded, provider: 'laya-coreml', requestedModel: 'laya-rl-agent', returnedModel: 'laya-rl-agent', policyVersion: LAYA_POLICY_VERSION }, batch)
  }
}
