import type { Context } from '@deepseek-ai/cordis'
import type { DshAgenticReplayHostServices, AgenticReplayToolExecution } from './agenticreplay-types.js'

/** Global Cordis observation with exact host bindings; result observer survives ingress shutdown. */
export function mountDshAgenticReplayHooks(ctx: Context, services: DshAgenticReplayHostServices): () => void {
  const disposers: (() => void)[] = []
  const on = (name: string, listener: (...args: any[]) => any, prepend = false) => disposers.push((ctx as any).on(name, listener, { global: true, prepend }))
  const binding = (exec: AgenticReplayToolExecution) => {
    try {
      const resolved = exec.agent?.session ? services.resolveSessionBinding(exec.agent, exec.agent.session) : undefined
      return resolved && services.canRecord(resolved) ? resolved : undefined
    } catch { return undefined }
  }
  try {
    on('llm/stream', (options: Record<string, any>, next: () => AsyncIterable<unknown>) => {
      let resolved
      try { if (typeof options.sessionId === 'string') resolved = services.resolveModelBinding(options.sessionId) } catch { /* no guessed attribution */ }
      if (resolved && !services.canRecord(resolved)) return next()
      return services.recorder.stream(resolved, options, next)
    }, true)
    on('agent/error', (event: { agent?: AgenticReplayToolExecution['agent'] }) => {
      try {
        const agent = event.agent
        const resolved = agent?.session ? services.resolveSessionBinding(agent, agent.session) : undefined
        if (resolved && services.canRecord(resolved)) services.recorder.nativeFailure(resolved)
      } catch { /* an observer never replaces the native error */ }
    })
    on('tools/pre-execute', async (exec: AgenticReplayToolExecution, next: () => Promise<unknown>) => {
      try { services.recorder.preTool(binding(exec), exec) } catch { /* observation cannot veto */ }
      const result = await next()
      try { services.recorder.toolDecision(exec, result) } catch { /* decision remains unchanged */ }
      return result
    })
    on('tools/execute', async (exec: AgenticReplayToolExecution, next: () => Promise<unknown>) => {
      try { services.recorder.toolDispatch(exec) } catch { /* transparent */ }
      try { return await next() } finally { try { services.recorder.toolDispatched(exec) } catch { /* transparent */ } }
    })
    on('tools/result', (exec: AgenticReplayToolExecution, result: unknown) => {
      try { services.recorder.toolResult(binding(exec), exec, result) } catch { /* synchronous non-vetoing notification */ }
    })

  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  let disposed = false
  return () => { if (disposed) return; disposed = true; for (const dispose of disposers.reverse()) dispose() }
}
