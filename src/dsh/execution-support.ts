import { randomUUID } from 'node:crypto'
import type { DshRuntime } from './runtime.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { executionFrameText, executionPathDenial, executionProposals, readExecutionFrame, saveExecutionFrame,
  updateExecutionFrame, type TaskExecutionFrame } from './execution-frame.js'
import { explorationOperation, newExplorationState, observeExploration, recordObject, evidencePresentation, acquiredReadRange,
  type ExecutionEvidence, type ExplorationState } from './exploration.js'

export const EXECUTION_STATUS_EVENT = 'kiokuko/execution-status'
export interface ExecutionBinding {
  runId: string
  sessionId: string
  nativeAgent?: object | undefined
  nativeSession?: object | undefined
  cwd: string
  task: string
  turn: number
  humanInput?: string
  terminal: boolean
  chat: boolean
  generation: string
}
interface SupportState {
  binding: ExecutionBinding
  frame?: TaskExecutionFrame
  degraded: boolean
  monitor: ExplorationState
  pending: ExecutionEvidence[]
  pendingIds: Set<string>
  evidence: ExecutionEvidence[]
  projected?: string
  loaded: boolean
  serial: number
  confirmations: Map<number, string>
}
interface SupportContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void
  tools?: { guard(listener: (execution: any) => string | undefined): () => void }
}

/** All optional observers contain failures; business receipts and leases are untouched. */
export class DshExecutionSupport {
  readonly #states = new Map<string, SupportState>()
  readonly #disposers: (() => void)[] = []
  readonly #started = new WeakMap<object, { binding: ExecutionBinding; epoch: number; warnings: string[] }>()
  #disposed = false
  constructor(private readonly runtime: Pick<DshRuntime, 'withDatabase'>) {}

  async refresh(binding: ExecutionBinding, human: boolean): Promise<void> {
    if (this.#disposed) return
    const previous = this.#states.get(binding.sessionId)
    let state = previous?.binding.runId === binding.runId ? previous : undefined
    if (!state) state = { binding, degraded: false, monitor: newExplorationState(binding.generation), pending: [], pendingIds: new Set(), evidence: [], loaded: false, serial: 0, confirmations: new Map() }
    state.binding = binding
    this.#states.set(binding.sessionId, state)
    if (binding.chat) return
    const current = state
    const serial = ++current.serial
    try {
      const pending = [...current.pending]
      const committed = await this.runtime.withDatabase(database => withImmediateTransaction(database, () => {
        if (this.#disposed || current.binding !== binding || current.serial !== serial) return undefined
        let monitor = structuredClone(current.monitor)
        let evidenceList = [...current.evidence]
        if (!current.loaded) {
          const row = database.prepare('SELECT state_json AS json FROM dsh_exploration_states WHERE run_id = ?').get<{ json: string }>(binding.runId)
          if (row) {
            const persisted = JSON.parse(row.json) as ExplorationState
            if (persisted.version !== 1 || !persisted.counts || typeof persisted.counts !== 'object'
              || !Array.isArray(persisted.warned) || typeof persisted.humanEpoch !== 'number'
              || typeof persisted.total !== 'number' || typeof persisted.paused !== 'boolean') throw new Error('Invalid exploration state')
            monitor = persisted
          }
          evidenceList = database.prepare('SELECT evidence_json AS json FROM dsh_execution_evidence WHERE run_id = ? ORDER BY rowid DESC LIMIT 32')
            .all<{ json: string }>(binding.runId).reverse().map(row => JSON.parse(row.json) as ExecutionEvidence)
        }
        const stored = readExecutionFrame(database, binding.runId)
        const frame = human || !stored ? updateExecutionFrame(stored, binding.cwd, binding.task) : stored
        saveExecutionFrame(database, binding.runId, frame)
        if (human && (binding.humanInput ? binding.humanInput !== monitor.humanInput : binding.turn > (monitor.humanTurn ?? 0))) {
          monitor = { ...newExplorationState(binding.generation, monitor.humanEpoch + 1), humanTurn: binding.turn,
            ...(binding.humanInput === undefined ? {} : { humanInput: binding.humanInput }) }
        } else if (monitor.generation !== binding.generation) {
          monitor = { ...newExplorationState(binding.generation, monitor.humanEpoch), humanTurn: monitor.humanTurn ?? 0, ...(monitor.humanInput === undefined ? {} : { humanInput: monitor.humanInput }) }
        }
        // Event identity and a single transaction make replay and completion order irrelevant.
        for (const evidence of pending.sort((a, b) => a.id.localeCompare(b.id))) {
          const inserted = database.prepare('INSERT OR IGNORE INTO dsh_execution_evidence VALUES (?, ?, ?) RETURNING evidence_id')
            .get(binding.runId, evidence.id, JSON.stringify(evidence))
          if (inserted) {
            evidenceList = [...evidenceList, evidence].slice(-32)
            if (!human && !binding.terminal && evidence.generation === binding.generation) monitor = observeExploration(monitor, evidence)
          }
        }
        database.prepare(`INSERT INTO dsh_exploration_states VALUES (?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
          .run(binding.runId, JSON.stringify(monitor), new Date().toISOString())
        return { frame, monitor, evidenceList }
      }))
      if (!committed || this.#disposed || current.binding !== binding || current.serial !== serial) return
      current.frame = committed.frame; current.monitor = committed.monitor; current.evidence = committed.evidenceList
      if (human) current.confirmations.clear()
      const consumed = new Set(pending.map(item => item.id))
      current.pending = current.pending.filter(item => !consumed.has(item.id))
      for (const id of consumed) current.pendingIds.delete(id)
      current.loaded = true; current.degraded = false
    } catch {
      if (current.binding !== binding || this.#disposed) return
      current.degraded = true; current.monitor.paused = false; delete current.monitor.pauseKey
    }
  }

  async proposals(sessionId: string, value: unknown, revision: number): Promise<void> {
    const state = this.#states.get(sessionId)
    if (!state?.frame || state.binding.terminal) return
    try {
      const proposed = executionProposals(value, state.binding.task, revision)
      if (!proposed.length) {
        // Ideal hints are reviewed with the actual succeeding plan revision.
        const carried = state.frame.conditions.filter(item => item.approval === 'proposed')
        if (!carried.length) return
        proposed.push(...carried.map(item => ({ ...item, planRevision: revision })))
      }
      const frame = { ...state.frame, conditions: [...state.frame.conditions.filter(item => item.approval !== 'proposed'), ...proposed] }
      const binding = state.binding
      const expectedFrame = state.frame
      await this.runtime.withDatabase(db => {
        if (!this.#disposed && state.binding === binding && state.frame === expectedFrame) {
          saveExecutionFrame(db, binding.runId, frame); state.frame = frame; state.serial++
        }
      })
    } catch { /* optional candidate failure never changes submission outcome */ }
  }

  confirmation(sessionId: string, revision: number): string[] {
    const state = this.#states.get(sessionId)
    const conditions = state?.frame?.conditions.filter(item => item.approval === 'proposed' && item.planRevision === revision) ?? []
    state?.confirmations.set(revision, canonicalContentHash(conditions))
    return conditions.map(item => `${item.field}: ${item.text}\n  Source: ${item.source.quote}`)
  }
  async approve(sessionId: string, revision: number): Promise<void> {
    const state = this.#states.get(sessionId)
    if (!state?.frame) return
    const candidates = state.frame.conditions.filter(item => item.approval === 'proposed' && item.planRevision === revision)
    if (!candidates.length || state.confirmations.get(revision) !== canonicalContentHash(candidates)) return
    try {
      const frame: TaskExecutionFrame = { ...state.frame, revision: state.frame.revision + 1,
        conditions: state.frame.conditions.filter(item => item.approval !== 'approved' || !candidates.some(candidate => candidate.field === item.field))
          .map(item => item.approval === 'proposed' && item.planRevision === revision ? { ...item, approval: 'approved' } : item) }
      const binding = state.binding
      const expectedFrame = state.frame
      await this.runtime.withDatabase(db => {
        if (!this.#disposed && state.binding === binding && state.frame === expectedFrame) {
          saveExecutionFrame(db, binding.runId, frame); state.frame = frame; state.serial++
        }
      })
    } catch { state.degraded = true }
  }

  async pauseAtBoundary(sessionId: string, notify: (id: string, text: string) => Promise<void>): Promise<boolean> {
    const state = this.#states.get(sessionId)
    if (!state || state.degraded || state.binding.terminal || state.binding.chat) return false
    if (state.monitor.paused) return true
    if (!state.monitor.pauseKey) return false
    const monitor = state.monitor
    const epoch = monitor.humanEpoch
    const binding = state.binding
    const id = canonicalContentHash({ runId: binding.runId, epoch, generation: monitor.generation, key: monitor.pauseKey })
    try {
      await notify(id, '探索を一時停止しました。同じ検索・読み取りが繰り返されています。会話と作業結果は保持しています。対象を絞る指示、続行、または中止を入力してください。\nExploration paused after repeated identical results. Enter a narrower instruction, continue, or stop. The run remains resumable.')
      if (this.#disposed || this.#states.get(sessionId) !== state || state.binding !== binding || state.monitor.humanEpoch !== epoch) return false
      const paused = { ...monitor, paused: true }
      await this.runtime.withDatabase(db => {
        if (state.binding !== binding || state.monitor.humanEpoch !== epoch) return
        db.prepare('UPDATE dsh_exploration_states SET state_json = ? WHERE run_id = ?').run(JSON.stringify(paused), binding.runId)
        state.monitor = paused
      })
      return state.monitor.paused
    } catch { delete state.monitor.pauseKey; return false }
  }
  paused(sessionId: string): boolean { return this.#states.get(sessionId)?.monitor.paused ?? false }
  clear(sessionId: string): void { this.#states.delete(sessionId) }

  text(sessionId: string): string {
    const state = this.#states.get(sessionId)
    if (!state || state.binding.chat) return ''
    if (state.degraded) return 'Kiokuko execution support is degraded. Do not claim path enforcement or evidence coverage is complete. Preserve the user request; explain any affected operation separately.'
    const evidence = state.evidence.slice(-16).map(item => `${item.id.slice(0, 12)} ${item.operation.paths.join(', ').slice(0, 512)} ${JSON.stringify(item.operation.range).slice(0, 256)}: ${item.presentation} (tool success: ${item.toolSucceeded ?? 'unknown'}; acquired range: ${JSON.stringify(item.acquiredRange ?? null)}; acquired: ${item.acquisition ?? 'unknown'}; source event: ${item.sourceSeq ?? 'unknown'}; result digest: ${item.digest.slice(0, 12)})`)
    return [state.frame ? executionFrameText(state.frame) : '', state.binding.terminal ? 'Terminal state: report recorded results now. Do not run more tools.' : state.monitor.notice ?? '',
      evidence.length ? `Recent evidence presentation (specified ranges only):\n${evidence.join('\n').slice(0, 4096)}` : ''].filter(Boolean).join('\n')
  }

  /** Intake runs after native assembly. Refresh that same snapshot before commit,
   * including the first request and steering; never fabricate a human input. */
  projectMessages(sessionId: string, messages: readonly any[]): readonly any[] {
    try {
      const state = this.#states.get(sessionId)
      if (!state || state.binding.chat) return messages
      const text = this.text(sessionId)
      const isSnapshot = (message: any) => message?.source?.plugin === '@deepseek-ai/dsh-system-prompt'
        && message.source.form === 'snapshot' && Array.isArray(message.source.sections)
      const current = [...messages].reverse().find(isSnapshot)
      const retained = current ? undefined : (state.binding.nativeSession as any)?.snapshotEvents?.()?.findLast((event: any) =>
        isSnapshot(event.data?.message ?? event.data))
      const before = current ?? retained?.data?.message ?? retained?.data
      const sections = [...(before?.source.sections ?? []).filter((item: any) => item.name !== 'kiokuko:execution'),
        { name: 'kiokuko:execution', text }]
      const body = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
        + sections.map(item => item.text).join('\n\n')
      if (!current && (before?.content?.[0]?.text === body || (!before && state.projected === body))) return messages
      state.projected = body
      const snapshot = { ...(current ?? { id: randomUUID(), role: 'user' }),
        content: [{ type: 'text', text: body }], source: {
          kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections,
        } }
      return current ? messages.map(message => message === current ? snapshot : message) : [...messages, snapshot]
    } catch { return messages }
  }

  mount(ctx: SupportContext): void {
    const stateFor = (agent: any): SupportState | undefined => {
      const state = this.#states.get(agent?.session?.id)
      return state && state.binding.nativeAgent === agent && state.binding.nativeSession === agent.session ? state : undefined
    }
    if (ctx.tools) this.#disposers.push(ctx.tools.guard(execution => {
      const state = stateFor(execution.agent)
      if (!state || state.binding.chat || state.binding.terminal) return undefined
      try {
        if (!this.#started.has(execution)) this.#started.set(execution, {
          binding: state.binding, epoch: state.monitor.humanEpoch, warnings: [...(state.monitor.presented ?? [])],
        })
        const operation = explorationOperation(execution.name, execution.arguments, state.binding.cwd)
        if (!operation) return undefined
        if (state.degraded && state.frame?.conditions.some(item => item.approval !== 'proposed' && ['readPaths', 'writePaths', 'excludedPaths'].includes(item.field))) {
          return 'Kiokuko: the existing task path policy is unavailable for this operation. Conversation and recovery remain available.'
        }
        return state.frame ? executionPathDenial(state.frame, operation.kind, operation.paths) : undefined
      } catch { return undefined }
    }))
    this.#disposers.push(ctx.on('tools/result', (execution: any, result: any) => {
      try {
        const state = stateFor(execution.agent)
        if (!state || state.binding.chat || state.binding.terminal) return
        const started = this.#started.get(execution)
        if (!started || started.binding.runId !== state.binding.runId || started.binding.turn !== state.binding.turn
          || started.binding.generation !== state.binding.generation || started.epoch !== state.monitor.humanEpoch) return
        const operation = explorationOperation(execution.name, execution.arguments, state.binding.cwd)
        if (!operation || operation.kind !== 'read') return
        const id = canonicalContentHash({ runId: state.binding.runId, turn: state.binding.turn, callId: execution.callId })
        if (state.pendingIds.has(id)) return
        state.pendingIds.add(id)
        const digest = canonicalContentHash(result.content)
        const resultKey = canonicalContentHash({ operation: operation.key, result: digest })
        const acquiredRange = acquiredReadRange(result.value)
        state.pending.push({ id, callId: execution.callId, rootCallId: execution.rootCallId ?? execution.callId,
          turn: state.binding.turn, generation: state.binding.generation, operation,
          digest, presentation: 'unknown', acquisition: result.isError ? 'unknown' : evidencePresentation(result.content, digest), toolSucceeded: !result.isError,
          ...(acquiredRange === undefined ? {} : { acquiredRange }),
          afterCorrection: started.warnings.includes(resultKey) })
      } catch { /* observe only */ }
    }))
    this.#disposers.push(ctx.on('session/event', (session: any, event: any) => {
      // Native append follows tools/result. Capture the cursor incrementally;
      // do not rescan a long conversation for every piece of evidence.
      try {
        const state = this.#states.get(session?.id)
        if (!state || state.binding.nativeSession !== session || event.type !== 'tool/result') return
        const callId = event.data?.message?.content?.[0]?.toolCallId
        if (typeof event.seq !== 'number' || typeof callId !== 'string') return
        for (const item of [...state.pending, ...state.evidence]) {
          if (item.callId === callId && item.turn === event.data?.turn) item.sourceSeq = event.seq
        }
      } catch { /* missing cursor is unknown evidence, never a native log failure */ }
    }))
    // rc.1 agent/request carries configuration only. Dynamic context belongs to
    // the native assembly/snapshot channel, which replaces rather than appends.
    this.#disposers.push(ctx.on('system-prompt/assemble', async (_assembly: any, context: any, next: () => Promise<any>) => {
      const assembly = await next()
      try {
        const state = stateFor(context.scope)
        if (!state) return assembly
        await this.refresh(state.binding, false)
        const text = this.text(state.binding.sessionId)
        if (!text) return assembly
        return { ...assembly, contexts: [...assembly.contexts.filter((item: any) => item.name !== 'kiokuko:execution'),
          { name: 'kiokuko:execution', text: '{{kiokuko_execution_frame}}' }],
          variables: { ...assembly.variables, kiokuko_execution_frame: text } }
      } catch { return assembly }
    }))
    this.#disposers.push(ctx.on('llm/stream', (request: any, next: () => AsyncIterable<any>) => {
      // Read-only at the final native model-request seam. PTC children absent
      // from model history deliberately remain unknown.
      try {
        const state = this.#states.get(request.sessionId)
        if (state && Array.isArray(request.messages)) {
          for (const evidence of [...state.evidence, ...state.pending]) {
            let visible: unknown
            for (const message of request.messages) {
              if (!Array.isArray(message.content)) continue
              for (const block of message.content) {
                if ((block.type === 'tool_result' || block.type === 'tool-result') && (block.toolCallId ?? block.callId) === evidence.callId) visible = block.content
              }
              if (message.source?.callId === evidence.callId) visible = message.content?.[0]?.content
            }
            evidence.presentation = visible === undefined ? 'unknown' : evidencePresentation(visible, evidence.digest)
          }
          if (!state.binding.terminal) state.monitor.presented = [...state.monitor.warned]
          const observed = state.evidence.map(item => ({ ...item }))
          void this.runtime.withDatabase(db => {
            for (const item of observed) db.prepare('UPDATE dsh_execution_evidence SET evidence_json = ? WHERE run_id = ? AND evidence_id = ?')
              .run(JSON.stringify(item), state.binding.runId, item.id)
          }).catch(() => { for (const item of state.evidence) item.presentation = 'unknown' })
        }
      } catch { /* observational failure must not change the request */ }
      return next()
    }))
  }
  dispose(): void {
    this.#disposed = true
    for (const dispose of this.#disposers.reverse()) { try { dispose() } catch { /* dispose remaining observers */ } }
    this.#states.clear()
  }
}
