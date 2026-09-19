import { z } from 'zod'
import { LispError } from '../lisp/contracts.js'

export const TYPESAFE_BYTES = 256 * 1024
export const TYPESAFE_MODEL = 'jev-latest'
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

const messages = {
  INVALID_REQUEST: 'Invalid TypeSafe request; check state, questions, model and timeout.',
  REQUEST_TOO_LARGE: 'TypeSafe request exceeds 256 KiB; select less material.',
  RESPONSE_TOO_LARGE: 'TypeSafe response exceeds 256 KiB.',
  MALFORMED_RESPONSE: 'TypeSafe returned an invalid response.',
  MISSING_CREDENTIAL: 'TypeSafe key is not configured. Use /kioku-typesafe-key <key>.',
  CREDENTIAL_UNAVAILABLE: 'The TypeSafe credential provider could not resolve the key.',
  STORAGE_UNAVAILABLE: 'DSH credential storage is unavailable; configure TYPESAFE_API_KEY in the host environment.',
  STORAGE_FAILED: 'DSH could not save or clear the TypeSafe key. Check credential storage and status.',
  READ_ONLY: 'The effective TypeSafe credential is read-only; change its inherited environment source.',
  INVALID_KEY: 'Supply one nonempty key without whitespace, quotes or control characters.',
  AUTH: 'TypeSafe rejected authentication; check /kioku-typesafe-key status and replace the key.',
  RATE_LIMIT: 'TypeSafe rate limit reached. No automatic retry was made.',
  TIMEOUT: 'TypeSafe request timed out. No automatic retry was made.',
  CANCELLED: 'TypeSafe request was cancelled.',
  UNAVAILABLE: 'TypeSafe service is unavailable. No automatic retry was made.',
} as const
export class TypeSafeError extends LispError {
  constructor(kind: keyof typeof messages) {
    super(`TYPESAFE_${kind}`, messages[kind], 'Inspect the request or credential status before a new explicit call. Ordinary service errors do not require Lisp recovery.')
  }
}

// JSON is the only transport representation. Reject values JSON.stringify would silently alter.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(z.string(), json)]))
const material = z.union([z.string(), z.array(json), z.record(z.string(), json)])
const key = z.string().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value))
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: material, criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: material, criteria: z.record(key, z.string().nullable()).refine(value => Object.keys(value).length >= 2) }).strict(),
  z.object({ type: z.literal('score'), instructions: material, criteria: z.array(z.string()).min(2) }).strict(),
])
const request = z.object({ state: material, questions: z.record(key, question).refine(value => Object.keys(value).length > 0),
  model: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).default(TYPESAFE_MODEL),
  timeoutMs: z.number().int().min(1).max(600_000).default(30_000) }).strict()
export type TypeSafeRequest = z.infer<typeof request>
const probability = z.number().finite().min(0).max(1)
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }).strict(),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(key, probability), confidence: probability }).strict(),
  z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(key, z.string()), probabilities: z.record(key, probability), confidence: probability }).strict(),
])
const response = z.object({ model: z.string().min(1).max(256), answers: z.record(key, answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict() }).strict()
export type TypeSafeResponse = z.infer<typeof response>

export function parseTypeSafeRequest(value: unknown): { request: TypeSafeRequest; body: string } {
  try {
    // Bound hostile inputs before recursive schema validation (including cycles).
    if (Buffer.byteLength(JSON.stringify(value)) > TYPESAFE_BYTES) throw new TypeSafeError('REQUEST_TOO_LARGE')
    const parsed = request.parse(value)
    const body = JSON.stringify({ state: parsed.state, model: parsed.model, questions: parsed.questions })
    if (Buffer.byteLength(body) > TYPESAFE_BYTES) throw new TypeSafeError('REQUEST_TOO_LARGE')
    return { request: parsed, body }
  } catch (error) { throw error instanceof TypeSafeError ? error : new TypeSafeError('INVALID_REQUEST') }
}
function sameKeys(actual: object, expected: string[]): boolean {
  return Object.keys(actual).length === expected.length && expected.every(id => Object.hasOwn(actual, id))
}
export function parseTypeSafeResponse(value: unknown, input: TypeSafeRequest): TypeSafeResponse {
  try {
    const parsed = response.parse(value)
    if (!sameKeys(parsed.answers, Object.keys(input.questions))) throw new Error()
    for (const [id, q] of Object.entries(input.questions)) {
      const a = parsed.answers[id]!
      if (a.type !== q.type) throw new Error()
      if (a.type === 'noul') continue
      const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.type === 'score' ? q.criteria.map((_, index) => String(index)) : []
      if (!sameKeys(a.probabilities, keys) || Math.abs(Object.values(a.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.001) throw new Error()
      if (a.type === 'choice' && (!keys.includes(a.choice) || a.probabilities[a.choice]! + 0.001 < Math.max(...Object.values(a.probabilities)))) throw new Error()
      if (a.type === 'score' && q.type === 'score') {
        if (a.score < 0 || a.score > q.criteria.length - 1 || !sameKeys(a.legend, keys) || keys.some(k => a.legend[k] !== q.criteria[Number(k)])) throw new Error()
      }
    }
    return parsed
  } catch { throw new TypeSafeError('MALFORMED_RESPONSE') }
}
