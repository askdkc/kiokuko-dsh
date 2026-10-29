import { createHash } from 'node:crypto'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

type Event = { type: string; seq: number; data: any }
type Selection = { provider: string; model: string; reasoningEffort?: string }
type Session = { id: string; header: { id?: string; cwd?: string; agentPreset?: string; origin?: string }; snapshotEvents(): readonly Event[] }
type Agent = { id: string; status: string; session: Session; model?: { current(): Selection | undefined; select(value: Selection): void }; followup(message: unknown): void; inbox?: { nextStep?: readonly { id: string }[]; nextTurn?: readonly { id: string }[] } }
export interface RecoveryHost { get(name: string, strict?: boolean): any }
export interface RecoveryStatus {
  sessionId: string; seq: number; interrupted: boolean; busy: boolean; canContinue: boolean; canRestart: boolean
  model: Selection | null; modelAvailable: boolean; originalRequest: string; attachments: number
  unknownCalls: { id: string; name: string }[]; warnings: string[]; lastRestart?: { sessionId: string; draft: string }
}
export interface RecoveryInput { sessionId: string; action: 'continue' | 'new'; operationId: string; expectedSeq: number }
export interface RecoveryResult { sessionId: string; sourceSessionId: string; action: 'continue' | 'new'; draft?: string; warnings: string[] }
export class SessionRecoveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:kiokuko-dsh/session-recovery': RecoveryInput & { version: 1; sourceSessionId: string; targetSessionId: string; state: 'planned' | 'accepted' }
  }
}
const RECORD = 'plugin:kiokuko-dsh/session-recovery'
const CAUTION = '中断した処理の結果を成功とみなさず、現在のファイルや外部状態を確認してください。結果不明の変更・送信・削除を無条件に再実行しないでください。前プロセスのバックグラウンドジョブ ID は復元できません。古い ID を再利用せず、必要な処理は状態を確認してから開始してください。'
function requestOf(events: readonly Event[]): { text: string; attachments: number } {
  const messages = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && !String(event.data.id ?? '').startsWith('kiokuko-recovery:'))
  const texts = messages.map(event => (Array.isArray(event.data.content) ? event.data.content : []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'))
  const text = texts.length === 1 ? texts[0] : texts.map((value, index) => `【ユーザーの依頼 ${index + 1}】\n${value}`).join('\n\n')
  return { text: text ?? '', attachments: messages.reduce((sum, event) => sum + (Array.isArray(event.data.content) ? event.data.content : []).filter((block: any) => block.type !== 'text').length, 0) }
}

function recordedSelection(events: readonly Event[]): Selection | undefined {
  let used: Selection | undefined, pending: Selection | undefined
  for (const event of events) {
    const value = event.type === 'model/selection' ? event.data : event.type === 'request/header' ? event.data?.header?.config : undefined
    if (typeof value?.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model) continue
    const next = { provider: value.provider, model: value.model, ...(event.type === 'request/header' && event.data?.header?.adapterDefaults?.reasoningEffort === true || value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
    if (event.type === 'model/selection') pending = next
    else { used = next; if (pending && pending.provider === next.provider && pending.model === next.model && pending.reasoningEffort === next.reasoningEffort) pending = undefined }
  }
  return pending ?? used
}
function targetId(source: string, operation: string): string {
  const hash = createHash('sha256').update(source).update('\0').update(operation).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Native history is retained; only an explicit human recovery action may enqueue work. */
export class SessionRecovery {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly handles: { dispose(): Promise<void> }[] = []
  private readonly lifetime = new AbortController()
  constructor(private readonly host: RecoveryHost) {}
  private agent(id: string): Agent | undefined { return this.host.get('agents', false)?.get(id) }
  private assertCurrent(agent: Agent, idle = true): void {
    if (this.lifetime.signal.aborted || this.agent(agent.id) !== agent || this.host.get('sessions', false)?.get(agent.session.id) !== agent.session) throw new SessionRecoveryError('session_changed', 'セッションの接続が変わりました。状態を再確認してください。')
    if (idle && agent.status !== 'idle') throw new SessionRecoveryError('session_busy', '実行中のセッションは復旧操作できません。現在の処理が終わってから再確認してください。')
  }
  private async snapshot(id: string): Promise<{ session: Session; agent?: Agent }> {
    const agent = this.agent(id)
    if (agent && agent.status !== 'disposed') {
      if (agent.id !== id || agent.session.id !== id || this.host.get('sessions', false)?.get(id) !== agent.session) throw new SessionRecoveryError('session_identity', 'セッションの識別情報が一致しません。')
      return { session: agent.session, agent }
    }
    const persistence = this.host.get('sessionPersistence', false)
    if (!persistence?.open) throw new SessionRecoveryError('session_unavailable', '保存済みセッションを読み込めません。', 404)
    const handle = await persistence.open(id, 'read', { signal: this.lifetime.signal })
    try {
      const value = await handle.read()
      const header = value.meta ?? value.header ?? handle.header
      if (header?.id !== id || !Array.isArray(value.events)) throw new SessionRecoveryError('session_identity', '保存済みセッションの識別情報が一致しません。')
      return { session: { id, header, snapshotEvents: () => value.events } }
    } finally { await handle.close() }
  }
  async inspect(id: string): Promise<RecoveryStatus> {
    const { session, agent } = await this.snapshot(id)
    const events = session.snapshotEvents()
    const lastEnd = [...events].reverse().find(event => event.type === 'turn/end')
    const lastStart = [...events].reverse().find(event => event.type === 'turn/start')
    const calls = new Map<string, { id: string; name: string }>()
    for (const event of events) {
      if (event.type === 'tool/call' && typeof event.data.callId === 'string') calls.set(`${event.data.turn}:${event.data.callId}`, { id: event.data.callId, name: String(event.data.name ?? 'tool') })
      if (event.type === 'tool/result' && event.data.error?.code !== 'TOOL_OUTCOME_UNKNOWN') calls.delete(`${event.data.turn}:${event.data.message?.toolCallId}`)
    }
    const reason = lastEnd?.data?.reason?.kind
    const interrupted = calls.size > 0 || !!lastStart && (!lastEnd || lastStart.seq > lastEnd.seq || ['interrupted', 'error', 'cancelled'].includes(reason))
    const model = agent?.model?.current() ?? recordedSelection(events) ?? null
    const providers = this.host.get('llm', false)?.listProviders?.() ?? []
    const modelAvailable = !!model && providers.some((provider: { id: string }) => provider.id === model.provider)
    const archived = this.host.get('workspaceRegistry', false)?.archivedSessionIds?.includes(id) === true
    const busy = agent?.status === 'running'
    const root = session.header.origin !== 'subagent' && !archived
    const request = requestOf(events)
    const warnings = interrupted ? [CAUTION] : []
    if (request.text.length > 131072) warnings.push('元の依頼が長いため自動転記できません。必要な部分を元の会話からコピーしてください。')
    if (!modelAvailable) warnings.push('保存されたモデル接続が利用できません。接続を復旧するかモデルを選び直してください。新規会話は作成できます。')
    if (request.attachments) warnings.push('新しい会話では、元の添付ファイルを再添付してください。')
    const restarted = [...events].reverse().find(event => event.type === RECORD && event.data?.action === 'new' && event.data?.version === 1 && event.data?.sourceSessionId === id && typeof event.data.operationId === 'string' && event.data.targetSessionId === targetId(id, event.data.operationId))?.data
    const lastRestart = restarted && (this.agent(restarted.targetSessionId) || await this.host.get('sessionPersistence', false)?.stat?.(restarted.targetSessionId)) ? { sessionId: restarted.targetSessionId, draft: this.draft(requestOf(events.filter(event => event.seq <= restarted.expectedSeq)).text) } : undefined
    return { sessionId: id, seq: events.at(-1)?.seq ?? -1, interrupted, busy, canContinue: root && interrupted && !busy && modelAvailable, canRestart: root && !busy && !!(this.host.get('sessionController', false)?.create || this.host.get('agents', false)?.create), model, modelAvailable, originalRequest: request.text.length > 131072 ? '' : request.text, ...(lastRestart ? { lastRestart } : {}), attachments: request.attachments, unknownCalls: [...calls.values()], warnings }
  }
  private draft(text: string): string { return text.length > 131072 ? '' : `${text}\n\n【中断後のやり直し】\n${CAUTION}` }
  private async activate(id: string): Promise<Agent> {
    let agent = this.agent(id)
    if (!agent || agent.status === 'disposed') {
      const controller = this.host.get('sessionController', false)
      if (!controller?.follow) throw new SessionRecoveryError('open_session_first', 'このセッションを通常の履歴画面または /resume で開いてから操作してください。')
      const iterator = controller.follow({ sessionId: id, activate: true }, this.lifetime.signal)[Symbol.asyncIterator]()
      try { await iterator.next() } finally { await iterator.return?.() }
      agent = this.agent(id)
    }
    if (!agent) throw new SessionRecoveryError('session_unavailable', 'セッションを再接続できませんでした。')
    this.assertCurrent(agent, false)
    return agent
  }
  async act(input: RecoveryInput): Promise<RecoveryResult> {
    const previous = this.queues.get(input.sessionId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.perform(input))
    this.queues.set(input.sessionId, operation)
    try { return await operation } finally { if (this.queues.get(input.sessionId) === operation) this.queues.delete(input.sessionId) }
  }
  private async perform(input: RecoveryInput): Promise<RecoveryResult> {
    const agent = await this.activate(input.sessionId)
    const events = agent.session.snapshotEvents()
    const receipts = events.filter(event => event.type === RECORD && event.data?.operationId === input.operationId)
    const receipt = receipts.at(-1)?.data
    if (receipt && (receipt.version !== 1 || !['planned', 'accepted'].includes(receipt.state))) throw new SessionRecoveryError('operation_version', 'この復旧記録の形式には対応していません。元の履歴は保持されています。')
    if (receipt && (receipt.action !== input.action || receipt.expectedSeq !== input.expectedSeq || receipt.sourceSessionId !== input.sessionId)) throw new SessionRecoveryError('operation_conflict', '同じ復旧操作 ID が別の操作に使われています。')
    const status = await this.inspect(input.sessionId)
    this.assertCurrent(agent, false)
    const boundRequest = requestOf(events.filter(event => event.seq <= input.expectedSeq))
    const messageId = `kiokuko-recovery:${input.operationId}`
    const result = (sessionId: string): RecoveryResult => ({ sessionId, sourceSessionId: input.sessionId, action: input.action, ...(input.action === 'new' ? { draft: this.draft(boundRequest.text) } : {}), warnings: status.warnings })
    if (receipt?.state === 'accepted' || events.some(event => event.type === 'user/message' && event.data?.id === messageId) || [...agent.inbox?.nextStep ?? [], ...agent.inbox?.nextTurn ?? []].some(message => message.id === messageId)) return result(input.action === 'new' ? targetId(input.sessionId, input.operationId) : input.sessionId)
    this.assertCurrent(agent)
    if (status.seq !== (receipt ? receipts.at(-1)!.seq : input.expectedSeq)) throw new SessionRecoveryError('session_changed', 'セッションが更新されました。内容を再確認してから操作してください。')
    if (input.action === 'continue' && !status.canContinue) throw new SessionRecoveryError('model_unavailable', '続行できません。モデル接続とセッションの状態を確認してください。')
    if (input.action === 'new' && !status.canRestart) throw new SessionRecoveryError('restart_unavailable', 'このホストでは新しい会話を作成できません。')
    if (input.action === 'continue') {
      try { await this.host.get('llm', false).resolveCallConfig(status.model, this.lifetime.signal) }
      catch { throw new SessionRecoveryError('model_unavailable', '保存されたモデル接続を準備できません。接続を復旧するかモデルを選び直してください。') }
      this.assertCurrent(agent)
      if (agent.session.snapshotEvents().at(-1)?.seq !== status.seq) throw new SessionRecoveryError('session_changed', 'セッションが更新されました。再確認してください。')
    }
    const target = input.action === 'new' ? targetId(input.sessionId, input.operationId) : input.sessionId
    const record = (state: 'planned' | 'accepted') => appendPluginRecord(agent.session as never, RECORD, { version: 1, ...input, sourceSessionId: input.sessionId, targetSessionId: target, state })
    if (!receipt) record('planned')
    const intentSeq = agent.session.snapshotEvents().at(-1)?.seq
    await this.host.get('sessions', false)?.flush?.(agent.session)
    this.assertCurrent(agent)
    if (agent.session.snapshotEvents().at(-1)?.seq !== intentSeq) throw new SessionRecoveryError('session_changed', '復旧の準備中にセッションが更新されました。再確認してください。')
    if (input.action === 'continue') {
      agent.followup({ ...createUserMessage({ content: [{ type: 'text', text: `中断した作業を、保存された履歴を確認して続けてください。\n${CAUTION}` }], source: { kind: 'user' } }), id: MessageId(messageId) })
    } else {
      let targetAgent = this.agent(target)
      if (!targetAgent && await this.host.get('sessionPersistence', false)?.stat?.(target)) targetAgent = await this.activate(target)
      if (!targetAgent) {
        const controller = this.host.get('sessionController', false)
        if (controller?.create) {
          const workspace = this.host.get('workspaceRegistry', false)?.list?.().find((item: { sessionIds: string[] }) => item.sessionIds.includes(input.sessionId))
          const created = await controller.create({ sessionId: target, ...(workspace ? { workspaceId: workspace.id } : { cwd: agent.session.header.cwd }), ...(agent.session.header.agentPreset ? { agentPreset: agent.session.header.agentPreset } : {}) })
          if (created.sessionId !== target) throw new SessionRecoveryError('target_changed', '作成先の識別情報が変わりました。新しい会話の一覧を確認してください。')
          targetAgent = this.agent(target)
        } else {
          const presets = this.host.get('agentPresets', false)
          const preset = agent.session.header.agentPreset
          const handle = await this.host.get('agents', false).create({ sessionId: target, meta: { cwd: agent.session.header.cwd, ...(preset ? { agentPreset: preset } : {}) }, ...(status.modelAvailable ? { agentOptions: status.model } : {}), ...(preset && presets?.mount ? { setup: async (context: unknown) => { await presets.mount(context, preset) } } : {}) })
          this.handles.push(handle); targetAgent = handle.agent
        }
        if (status.modelAvailable && targetAgent?.model) {
          const targetSeq = targetAgent.session.snapshotEvents().at(-1)?.seq
          try {
            await this.host.get('llm', false).resolveCallConfig(status.model, this.lifetime.signal)
            if (this.lifetime.signal.aborted || this.agent(target) !== targetAgent || targetAgent.status !== 'idle' || targetAgent.session.snapshotEvents().at(-1)?.seq !== targetSeq) throw new Error('Target changed')
            targetAgent.model.select(status.model!)
          }
          catch { status.warnings.push('元のモデルを新しい会話へ設定できませんでした。送信前にモデルを選び直してください。') }
        }
      }
      if (!targetAgent || targetAgent.session.header.cwd !== agent.session.header.cwd) throw new SessionRecoveryError('target_identity', '新しい会話の作業場所を確認できません。')
    }
    if (this.agent(agent.id) === agent) record('accepted')
    return result(target)
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.queues.values())
    for (const handle of this.handles.splice(0)) await handle.dispose()
  }
}
