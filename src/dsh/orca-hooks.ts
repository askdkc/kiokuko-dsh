import type { Context } from '@deepseek-ai/cordis'
import type { DshOrcaHostServices, OrcaToolExecution } from './orca-types.js'

/** Global Cordis observation with exact host bindings; result observer survives ingress shutdown. */
export function mountDshOrcaHooks(ctx: Context, services: DshOrcaHostServices): () => void {
  const disposers: (() => void)[] = []
  const on = (name: string, listener: (...args: any[]) => any) => disposers.push((ctx as any).on(name, listener, { global: true }))
  const binding = (exec: OrcaToolExecution) => {
    try { return exec.agent?.session ? services.resolveSessionBinding(exec.agent, exec.agent.session) : undefined } catch { return undefined }
  }
  try {
    on('llm/stream', (options: Record<string, any>, next: () => AsyncIterable<unknown>) => {
      let resolved
      try { if (typeof options.sessionId === 'string') resolved = services.resolveModelBinding(options.sessionId) } catch { /* no guessed attribution */ }
      return services.recorder.stream(resolved, options, next)
    })
    on('tools/pre-execute', async (exec: OrcaToolExecution, next: () => Promise<unknown>) => {
      try { services.recorder.preTool(binding(exec), exec) } catch { /* observation cannot veto */ }
      const result = await next()
      try { services.recorder.toolDecision(exec, result) } catch { /* decision remains unchanged */ }
      return result
    })
    on('tools/execute', async (exec: OrcaToolExecution, next: () => Promise<unknown>) => {
      try { services.recorder.toolDispatch(exec) } catch { /* transparent */ }
      try { return await next() } finally { try { services.recorder.toolDispatched(exec) } catch { /* transparent */ } }
    })
    on('tools/result', (exec: OrcaToolExecution, result: unknown) => {
      try { services.recorder.toolResult(binding(exec), exec, result) } catch { /* synchronous non-vetoing notification */ }
    })

  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  let disposed = false
  return () => { if (disposed) return; disposed = true; for (const dispose of disposers.reverse()) dispose() }
}
