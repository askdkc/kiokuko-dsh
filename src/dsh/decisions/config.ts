import { z } from 'zod'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const LAYA_POLICY_VERSION = 'laya-coreml-choice-v1'
export const LAYA_MODELS = {
  'aac6fef/laya-multilingual-coreml': 1024,
  'aac6fef/laya-multilingual-coreml-ane': 96,
} as const
export const LAYA_SOCKET = '~/Library/Caches/laya-coreml/worker.sock'

const model = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const timeout = z.number().int().min(1).max(600000).default(5000)
const probability = z.number().min(0).max(1)
export function decisionEndpoint(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Decision endpoint requires HTTPS or loopback HTTP without credentials, query or fragment')
  return url.href
}
const endpoint = z.string().max(4096).transform((value, ctx) => {
  try { return decisionEndpoint(value) } catch { ctx.addIssue({ code: 'custom', message: 'Invalid decision endpoint' }); return z.NEVER }
})
export const TypedDecisionsConfig = z.object({
  mode: z.enum(['auto', 'off']).default('auto'), provider: z.enum(['typesafe', 'nimble', 'laya-coreml']).default('typesafe'),
  typesafe: z.object({ model: model.default('jev-latest'), timeoutMs: timeout,
    acceptance: z.object({ minConfidence: probability.default(0.8) }).strict().prefault({}),
  }).strict().prefault({}),
  nimble: z.object({ endpoint: endpoint.optional(), model: model.optional(), timeoutMs: timeout,
    credentialRef: z.string().min(1).max(256).regex(/^[A-Z][A-Z0-9_]*$/).refine(s => s !== 'TYPESAFE_API_KEY', 'Nimble cannot use the TypeSafe credential').optional(),
    acceptance: z.object({ minProbability: probability.default(0.9), minMargin: probability.default(0.2) }).strict().prefault({}),
  }).strict().prefault({}),
  'laya-coreml': z.object({
    socketPath: z.string().min(1).max(4096).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s) && (!s.startsWith('~') || s.startsWith('~/'))).default(LAYA_SOCKET),
    model: z.enum(['laya-rl-agent', 'aac6fef/laya-multilingual-coreml', 'aac6fef/laya-multilingual-coreml-ane']).optional(),
    protocol: z.literal('v1').optional(),
    runtimeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    adapterVersion: z.literal(LAYA_POLICY_VERSION).default(LAYA_POLICY_VERSION),
    timeoutMs: timeout,
    acceptance: z.object({ minProbability: probability.default(0.9), minMargin: probability.default(0.2) }).strict().prefault({}),
  }).strict().optional(),
}).strict()
export type DecisionConfiguration = z.infer<typeof TypedDecisionsConfig>
export type LayaSettings = NonNullable<DecisionConfiguration['laya-coreml']>

export function selectedDecisionSettings(config: DecisionConfiguration) { return config[config.provider] }
export function decisionConfigurationIssue(config: DecisionConfiguration): string | undefined {
  if (config.mode === 'off') return 'mode_off'
  if (config.provider === 'nimble' && (!config.nimble.endpoint || !config.nimble.model)) return 'missing_endpoint_or_model'
  if (config.provider === 'laya-coreml') {
    const laya = config['laya-coreml']
    if (laya?.protocol === 'v1') return laya.model === 'laya-rl-agent' && !laya.runtimeFingerprint ? undefined : 'invalid_laya_v1_configuration'
    if (!laya?.model || !laya.runtimeFingerprint) return 'missing_laya_model_or_fingerprint'
  }
  return undefined
}
/** Resolve new settings once, before binding. Parsing stored settings never consults cwd/home. */
export function resolveDecisionConfiguration(config: DecisionConfiguration, repositoryRoot: string): DecisionConfiguration {
  const laya = config['laya-coreml']
  if (!laya) return structuredClone(config)
  const path = laya.socketPath.startsWith('~/') ? resolve(homedir(), laya.socketPath.slice(2)) : resolve(repositoryRoot, laya.socketPath)
  return { ...structuredClone(config), 'laya-coreml': { ...laya, acceptance: { ...laya.acceptance }, socketPath: path } }
}
