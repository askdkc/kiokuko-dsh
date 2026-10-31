import { z } from 'zod'

export interface NativeStopIdentity {
  callId: string
  rootCallId: string
  ownerId: string
  sessionId: string
  cwd: string
}
const failure = z.object({
  isError: z.literal(true),
  error: z.object({ info: z.object({ code: z.literal('ABORTED') }) }),
  meta: z.object({ termination: z.object({
    version: z.literal(1), kind: z.literal('managed-range-empty'),
    callId: z.string(), rootCallId: z.string(), ownerId: z.string(), sessionId: z.string(), cwd: z.string(),
  }).strict() }),
})

/** Consume only the pinned host Bash dispatch result, never Lisp output or session text. */
export function nativeStopReceipt(result: unknown, expected: NativeStopIdentity) {
  const parsed = failure.safeParse(result)
  if (!parsed.success) return undefined
  const observed = parsed.data.meta.termination
  if (observed.callId !== expected.callId || observed.rootCallId !== expected.rootCallId
    || observed.ownerId !== expected.ownerId || observed.sessionId !== expected.sessionId || observed.cwd !== expected.cwd)
    return undefined
  return { route: 'native' as const, operationId: observed.callId, state: 'cancelled' as const,
    cancelled: true, processStopped: true, host: observed }
}
