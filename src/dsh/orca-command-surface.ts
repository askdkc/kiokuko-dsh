import type { DshPonytailCommandContext } from './commands.js'
import { DshOrcaReadService } from './orca-read-service.js'
import { OrcaError, type DshOrcaHostServices } from './orca-types.js'

/** Human-only native command. No HTTP route or model tool is registered. */
export function mountDshOrcaCommand(ctx: DshPonytailCommandContext, enabled: boolean, services?: DshOrcaHostServices): () => void {
  const reader = services ? new DshOrcaReadService(services.config, services.withIndex) : undefined
  return ctx.commands.register({ name: 'kioku-orca', description: 'Session recording: status | list | start | stop | show <run> [cursor] | export <run>',
    input: { hint: 'status | list | start | stop | show <run> [cursor] | export <run>' }, recordInput: false,
    handler: async invocation => {
      try {
        const agent = invocation.agent, session = agent?.session
        if (!agent || !session || (agent.sessionId !== undefined && agent.sessionId !== session.id)) throw new OrcaError('session_required')
        const args = invocation.rawInput.trim().split(/\s+/u)
        const [action, runId, cursor] = args
        if (!['status','list','start','stop','show','export'].includes(action ?? '')
          || args.length > (action === 'show' ? 3 : action === 'export' ? 2 : 1)
          || ((action === 'show' || action === 'export') && !runId)) throw new OrcaError('invalid_command')
        if (!enabled) return { kind: 'success', text: 'Orca recording: disabled. Enable orca.enabled in plugin configuration and reload.' }
        if (!services || !reader) return { kind: 'error', text: 'Orca recording: unavailable (native session/index/shutdown services required).' }
        const binding = services.resolveSessionBinding(agent, session)
        if (!binding || binding.sessionId !== session.id) throw new OrcaError('session_required')
        let result: unknown
        switch (action) {
          case 'status': result = services.recorder.status(binding.sessionId); break
          case 'list': result = await reader.list(binding); break
          case 'start': services.recorder.start(binding); result = { ...services.recorder.status(binding.sessionId), note: 'New observations only; past calls are not captured.' }; break
          case 'stop': await services.closeSessionRecording(binding.sessionId, 'manual'); result = services.recorder.status(binding.sessionId); break
          case 'show': result = await reader.show(binding, runId!, cursor); break
          case 'export': result = { path: await reader.export(binding, runId!), exactReplay: false }; break
        }
        return { kind: 'success', text: JSON.stringify(result, null, 2) }
      } catch (error) { return { kind: 'error', text: error instanceof OrcaError ? error.code : 'orca_operation_failed' } }
    },
  })
}
