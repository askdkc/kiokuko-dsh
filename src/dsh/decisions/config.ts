import { z } from 'zod'

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
  mode: z.enum(['auto', 'off']).default('auto'), provider: z.enum(['typesafe', 'nimble']).default('typesafe'),
  typesafe: z.object({ model: model.default('jev-latest'), timeoutMs: timeout,
    acceptance: z.object({ minConfidence: probability.default(0.8) }).strict().prefault({}),
  }).strict().prefault({}),
  nimble: z.object({ endpoint: endpoint.optional(), model: model.optional(), timeoutMs: timeout,
    credentialRef: z.string().min(1).max(256).regex(/^[A-Z][A-Z0-9_]*$/).refine(s => s !== 'TYPESAFE_API_KEY', 'Nimble cannot use the TypeSafe credential').optional(),
    acceptance: z.object({ minProbability: probability.default(0.9), minMargin: probability.default(0.2) }).strict().prefault({}),
  }).strict().prefault({}),
}).strict()
export type DecisionConfiguration = z.infer<typeof TypedDecisionsConfig>
