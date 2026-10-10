import type { DshPonytailCommandContext } from './commands.js'
import { DshAgenticReplayReadService } from './agenticreplay-read-service.js'
import { AgenticReplayError, type DshAgenticReplayHostServices } from './agenticreplay-types.js'
import { formatDshAgenticReplayStatus } from './agenticreplay-status-presentation.js'

/** Human-only native command. No HTTP route or model tool is registered. */
export function mountDshAgenticReplayCommand(ctx: DshPonytailCommandContext, enabled: boolean, services?: DshAgenticReplayHostServices): () => void {
  const reader = services ? new DshAgenticReplayReadService(services.config, services.withIndex) : undefined
  return ctx.commands.register({ name: 'kioku-agenticreplay', description: 'Session recording: status [--json] | list | start | stop | show <run> [cursor] | export <run>',
    input: { hint: 'status [--json] | list | start | stop | show <run> [cursor] | export <run>' }, recordInput: false,
    handler: async invocation => {
      try {
        const agent = invocation.agent, session = agent?.session
        if (!agent || !session || (agent.sessionId !== undefined && agent.sessionId !== session.id)) throw new AgenticReplayError('session_required')
        const args = invocation.rawInput.trim().split(/\s+/u)
        const [action, runId, cursor] = args
        if (!['status','list','start','stop','show','export'].includes(action ?? '')
          || args.length > (action === 'show' ? 3 : action === 'export' || action === 'status' ? 2 : 1)
          || (action === 'status' && runId !== undefined && runId !== '--json')
          || ((action === 'show' || action === 'export') && !runId)) throw new AgenticReplayError('invalid_command')
        if (!enabled) return { kind: 'success', text: action === 'status'
          ? runId === '--json' ? JSON.stringify({ capability: 'disabled' }, null, 2)
            : 'AgenticReplay: 機能が無効です\n設定で agenticReplay.enabled を true にして DSH を再読み込みしてください。'
          : 'AgenticReplay recording: disabled. Enable agenticReplay.enabled in plugin configuration and reload.' }
        if (!services || !reader) return { kind: 'error', text: 'AgenticReplay recording: unavailable (native session/index/shutdown services required).' }
        const binding = services.resolveSessionBinding(agent, session)
        if (!binding || binding.sessionId !== session.id) throw new AgenticReplayError('session_required')
        const status = async () => ({ ...services.recorder.status(binding.sessionId), ...await services.sessionRecordingStatus(binding) })
        let result: unknown
        switch (action) {
          case 'status': {
            const snapshot = await status()
            return { kind: 'success', text: runId === '--json' ? JSON.stringify(snapshot, null, 2)
              : formatDshAgenticReplayStatus(snapshot, binding.storeRoot) }
          }
          case 'list': result = await reader.list(binding); break
          case 'start': await services.setSessionRecording(binding, true); result = { ...await status(), note: 'New observations only; past calls are not captured.' }; break
          case 'stop': await services.setSessionRecording(binding, false); result = await status(); break
          case 'show': result = await reader.show(binding, runId!, cursor); break
          case 'export': result = { path: await reader.export(binding, runId!), exactReplay: false }; break
        }
        return { kind: 'success', text: JSON.stringify(result, null, 2) }
      } catch (error) { return { kind: 'error', text: error instanceof AgenticReplayError ? error.code : 'agenticreplay_operation_failed' } }
    },
  })
}
