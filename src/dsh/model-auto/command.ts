import type { DshNativeCommandDefinition } from '../commands.js'
import type { ModelAutoCoordinator } from './coordinator.js'

const usage = '/kioku-model-auto on | off | observe | status'
export function mountModelAutoCommand(commands: { register(definition: DshNativeCommandDefinition): () => void },
  coordinator: ModelAutoCoordinator, validSession: (agentId: string, sessionId: string) => boolean): () => void {
  return commands.register({ name: 'kioku-model-auto', description: 'Choose automatic model routing for this session or inspect its status.',
    input: { hint: 'on | off | observe | status' }, handler: async invocation => {
      const sessionId = invocation.agent?.session?.id ?? invocation.agent?.sessionId
      if (!sessionId || !invocation.agent || !validSession(invocation.agent.id, sessionId))
        return { kind: 'error', text: '現在のDSHセッションを確認できません。モデル自動選択は変更していません。' }
      const action = invocation.rawInput.trim()
      if (action && !['on', 'off', 'observe', 'status'].includes(action)) return { kind: 'error', text: usage }
      try {
        invocation.signal.throwIfAborted()
        if (action === 'on' || action === 'off' || action === 'observe') {
          await coordinator.setMode(sessionId, action === 'on' ? 'auto' : action)
          return { kind: 'success', text: action === 'on'
            ? '自動モデル選択をONにしました。手動pinを解除し、次の新規タスクから適用します。現在送信中の要求は切り替えません。'
            : action === 'observe' ? 'observeにしました。次の新規タスクから選択案を計測し、実モデルは維持します。'
              : '自動モデル選択をOFFにしました。未適用の判定は失効し、現在送信中の要求は切り替えません。' }
        }
        const status = await coordinator.status(sessionId)
        return { kind: 'success', text: `${action ? '' : `${usage}\n`}${JSON.stringify(status, null, 2)}` }
      } catch (error) {
        return { kind: 'error', text: `モデル自動選択を変更・確認できませんでした: ${error instanceof Error ? error.message : String(error)}` }
      }
    } })
}
