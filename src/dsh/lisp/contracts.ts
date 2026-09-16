import { createHash } from 'node:crypto'
import { z } from 'zod'

export const LispConfig = z.object({
  enabled: z.boolean().default(false), sbclPath: z.string().min(1).default('sbcl'),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  startupTimeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  maxWorkers: z.number().int().min(1).max(32).default(4),
  maxOutputBytes: z.number().int().min(1024).max(8_388_608).default(8_388_608),
}).strict()
export type LispConfiguration = z.infer<typeof LispConfig>
export const LISP_TOOLS = ['lisp_eval', 'lisp_describe', 'lisp_inspect', 'lisp_status', 'lisp_cancel', 'lisp_reset'] as const
export type LispTool = typeof LISP_TOOLS[number]
export const FRAME_BYTES = 1_048_576
export const FILE_BYTES = 64 * 1024 * 1024
export const RESULT_BYTES = 64 * 1024
export const identifier = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u)
export interface LispOwner { sessionId: string; agentId: string; root: string }
export type LispState = 'DISABLED' | 'PREFLIGHT' | 'READY' | 'EVALUATING' | 'STOPPING' | 'RECOVERY_REQUIRED' | 'STOP_UNCONFIRMED'
export class LispError extends Error {
  constructor(readonly code: string, message: string, readonly recovery = '/kioku-lisp status で状態を確認してください。') { super(message); this.name = 'LispError' }
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    return item
  })).digest('hex')
}
/** Preserve valid JSON and UTF-8 even when the complete result is too large. */
export function renderResult(value: unknown): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) <= RESULT_BYTES) return json
  return JSON.stringify({ truncated: true, message: '応答が表示上限を超えました。lisp_status または /kioku-lisp diagnostics で操作 ID を確認してください。', preview: Buffer.from(json).subarray(0, 12000).toString('utf8') })
}
export function fail(code: string, message: string): never { throw new LispError(code, message) }
export function failure(error: unknown): { ok: false; code: string; message: string; recovery: string } {
  return error instanceof LispError ? { ok: false, code: error.code, message: error.message, recovery: error.recovery }
    : { ok: false, code: 'LISP_INTERNAL_ERROR', message: error instanceof Error ? error.message.slice(0, 1000) : 'Lisp 処理に失敗しました。', recovery: '/kioku-lisp status で確認し、/kioku-lisp recover で照合してください。自動再実行はしません。' }
}
export const EvalInput = z.object({ code: z.string().min(1).max(262_144), timeoutMs: z.number().int().min(100).max(600_000).optional(),
  inputs: z.array(z.string().min(1).max(4096)).max(100).default([]) }).strict()
export const ProposalRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('write'), path: z.string().min(1).max(4096), content: z.string().max(262_144) }).strict(),
  z.object({ operation: z.literal('delete'), path: z.string().min(1).max(4096) }).strict(),
])
export type ProposalInput = z.infer<typeof ProposalRequest>
export const WorkerFrame = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('ready') }).strict(),
  z.object({ version: z.literal(1), type: z.literal('result'), id: identifier, ok: z.boolean(), value: z.unknown(), proposals: z.array(ProposalRequest).max(100) }).strict(),
])
export type WorkerResult = Extract<z.infer<typeof WorkerFrame>, { type: 'result' }>
