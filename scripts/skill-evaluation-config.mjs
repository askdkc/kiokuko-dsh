import { z } from 'zod'

/** Explicit connection and reservation limits shared by the opt-in Skill evaluations. */
export function parseEvaluationConfig(input) {
  const config = z.object({
    model: z.string().min(1).max(256), revision: z.string().min(1).max(256),
    baseURL: z.string().url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/), allowRemote: z.boolean(),
    maxRequests: z.number().int().min(1).max(500), maxTokens: z.number().int().positive(),
    maxDurationMs: z.number().int().min(1000).max(3600000), contextWindow: z.number().int().min(4096).max(1048576),
    maxOutputTokens: z.number().int().min(64).max(4096), temperature: z.number().min(0).max(2),
  }).strict().parse(input)
  const endpoint = new URL(config.baseURL)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Invalid evaluation endpoint')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) && (!config.allowRemote || endpoint.protocol !== 'https:')) throw new Error('Remote evaluation requires HTTPS and allowRemote:true')
  return config
}

/** Reserve the worst-case request before dispatch. Failed requests keep their reservation. */
export function createEvaluationBudget(config, now = Date.now) {
  const started = now()
  let requests = 0, reservedTokens = 0, exhausted = false
  return {
    reserve() {
      const reservation = config.contextWindow + config.maxOutputTokens
      if (now() - started >= config.maxDurationMs || requests >= config.maxRequests || reservedTokens + reservation > config.maxTokens) { exhausted = true; return false }
      requests++; reservedTokens += reservation
      return true
    },
    snapshot() { return { requests, reservedTokens, elapsedMs: now() - started, exhausted } },
  }
}
