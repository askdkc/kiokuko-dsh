import type { DshSpawnBackend } from '../dsh/enno-delegation.js'
import type { RoutableAgent } from '../dsh/model-routing.js'
import { ManagedAgentExecutor } from '../dsh/orchestration/managed-agent-executor.js'
import { readExecutionOwner } from '../dsh/orchestration/execution-owner.js'
import { normalizeDshUsage } from '../dsh/efficiency.js'
import { DeepStore, assertDeepAuthority, readDeepState, type DeepAuthority } from './store.js'
import { DeepReadPort, DEEP_READ_TOOLS } from './read-port.js'
import type { DeepJob, DeepModel, DeepState } from './core/contracts.js'
import type { DeepExecution } from './scheduler.js'
import { deepMemoryRequestScope } from './memory-request.js'
import { estimateRequestTokens } from './core/budget.js'
import { isModelAvailabilityFailure } from '../dsh/model-routing.js'
import { DeepModelUnavailable } from './failures.js'
import { abortableStream } from './abortable-stream.js'

export interface DeepNativeAgent extends RoutableAgent {
  readonly options?: { provider?: string; model?: string; reasoningEffort?: string }
  readonly status?: string
  followup?(message: unknown): void
  cancel?(reason: unknown, options?: {keepInbox: boolean}): void
  whenIdle?(): Promise<void>
}
export interface DeepNativeContext { on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean; global?: boolean }): () => void }
interface Binding { authority: DeepAuthority; state: DeepState; model: DeepModel; parent: DeepNativeAgent; failure?: unknown }

function finiteUsage(chunk: unknown): number | undefined {
  const item = chunk as { type?: string; usage?: unknown }
  if (item?.type !== 'usage') return undefined
  const usage = normalizeDshUsage(item.usage)
  return usage.logicalInputTokens !== null && usage.outputTokens !== null ? usage.logicalInputTokens + usage.outputTokens : undefined
}

/** Uses the native spawn backend; no alternate harness or provider client. */
export class DeepNativeExecutor implements DeepExecution {
  readonly #managed: ManagedAgentExecutor<Binding>
  readonly #sessions = new Map<string, Binding>()
  readonly #disposers: (() => void)[] = []
  readonly #parents = new Map<string, DeepNativeAgent>()
  readonly #rootRuns = new WeakMap<object, string>()
  constructor(readonly store: DeepStore, readonly backend: DshSpawnBackend | undefined, ctx: DeepNativeContext) {
    this.#managed = new ManagedAgentExecutor(backend)
    this.#disposers.push(ctx.on('agent/created', ({ agent }: { agent: DeepNativeAgent }) => this.created(agent), { global: true, prepend: true }))
    this.#disposers.push(ctx.on('agent/request-error', (event: { agent: object }, next: () => unknown) => this.isChild(event.agent) ? undefined : next(), { global: true, prepend: true }))
    this.#disposers.push(ctx.on('llm/stream', (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => this.#stream(options, next), { global: true, prepend: true }))
  }
  setParent(runId: string, agent: DeepNativeAgent): void { this.#parents.set(runId, agent); this.#rootRuns.set(agent, runId) }
  releaseRun(runId: string): void { this.#parents.delete(runId) }
  isChild(agent: object): boolean { return this.#managed.binding(agent) !== undefined }
  observationBinding(agent: object): { runId: string; parentSessionId: string } | undefined {
    const binding = this.#managed.binding(agent)
    return binding && { runId: binding.state.runId, parentSessionId: binding.state.sessionId }
  }
  recordingRun(agent: object): string | undefined { return deepMemoryRequestScope.getStore()?.runId ?? this.#managed.binding(agent)?.state.runId ?? this.#rootRuns.get(agent) }
  clearParentObservation(agent: object): void { this.#rootRuns.delete(agent) }
  recordingParent(agent: object): { agent: DeepNativeAgent; session: object } | undefined {
    const parent = this.#managed.binding(agent)?.parent
    return parent?.session ? { agent: parent, session: parent.session } : undefined
  }
  capabilityProblem(agent: DeepNativeAgent): string | undefined {
    const spawn = (this.backend as DshSpawnBackend & { getProvider?: (name: string) => { capabilities: Record<string, boolean> } | undefined } | undefined)?.getProvider?.('spawn')
    if (!spawn || !['agentOptions', 'toolFilter', 'depthLimit'].every(key => spawn.capabilities[key])) return 'Deep requires a native spawn backend advertising agentOptions, toolFilter and depthLimit.'
    if (!agent.ctx || !agent.session || !agent.followup) return 'Deep requires the exact native Agent, Session and followup capability.'
    return undefined
  }
  created(agent: DeepNativeAgent): void {
    const binding = this.#managed.created(agent)
    if (!binding) return
    if (!agent.session || !agent.ctx) throw new Error('Deep child has no native scope')
    this.#sessions.set(agent.session.id, binding)
    const scope = agent.ctx as DeepNativeContext & { get(name: string, strict?: boolean): any }
    scope.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
      await this.beforeAssembly(agent)
      const result = await next()
      const { reasoningEffort: _inherited, ...base } = result
      return { ...base, ...binding.model, maxTokens: binding.state.configuration.budget.maxOutputTokensPerRequest }
    }, { prepend: true })
    scope.on('agent/request-error', (event: {failure:unknown}) => { binding.failure = event.failure; return undefined }, { prepend: true })
    scope.on('llm/stream', (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => {
      if (options.sessionId !== agent.session!.id) throw new Error('Deep requires Session identity on every native stream')
      return next()
    }, { prepend: true })
    const tools = scope.get('tools')
    if (!tools?.register || !tools?.guard) throw new Error('Deep scoped tool authority is unavailable')
    const reads = new DeepReadPort(this.store)
    for (const definition of reads.definitions(binding.authority)) tools.register(definition)
    tools.guard((execution: { name: string }) => DEEP_READ_TOOLS.includes(execution.name as typeof DEEP_READ_TOOLS[number]) ? undefined : 'Deep only permits its bounded workspace reads')
    scope.on('tools/execute', async (_execution: unknown, next: () => Promise<unknown>) => {
      await this.beforeAssembly(agent); return next()
    }, { prepend: true })
  }
  async beforeAssembly(agent: DeepNativeAgent): Promise<DeepModel | undefined> {
    const binding = this.#managed.binding(agent)
    if (!binding) {
      // A cold child is evidence to reconcile, never a root intake or automatically resumed request.
      const old = agent.session && await this.store.database(db => db.prepare('SELECT 1 FROM dsh_deep_attempts WHERE child_session_id=?').get(agent.session!.id))
      if (old) throw new Error('Deep child is no longer live. Reconcile it from its parent Session.')
      return undefined
    }
    await this.store.transaction(db => {
      assertDeepAuthority(db, readDeepState(db, binding.state.runId), binding.authority, this.store.now())
      db.prepare("UPDATE dsh_deep_attempts SET child_session_id=?,status='started' WHERE attempt_id=? AND (child_session_id IS NULL OR child_session_id=?)")
        .run(agent.session!.id, binding.authority.attemptId, agent.session!.id)
      if (db.prepare('SELECT changes() AS count').get<{count:number}>()?.count !== 1) throw new Error('Deep child binding changed')
    })
    return binding.model
  }
  async execute(authority: DeepAuthority, job: DeepJob, state: DeepState, signal: AbortSignal): Promise<unknown> {
    const parent = this.#parents.get(state.runId)
    if (!parent) throw new Error('Deep parent Session is unavailable')
    const binding: Binding = { authority, state, model: state.configuration.roles[job.role], parent }
    try { return await this.#managed.execute(binding, { parent, signal, agentOptions: binding.model, maxDepth: 1, toolFilter: { allow: [] }, label: `Deep ${job.role}`,
      prompt: [{ type: 'text', text: job.prompt }] }, async (result, agent) => {
      await this.beforeAssembly(agent)
      if (isModelAvailabilityFailure(binding.failure)) throw new DeepModelUnavailable('選択したDeepモデルが利用できません。--configure で構成を選び直してください。')
      if (result.stopReason !== 'completed') throw new Error(`Deep child stopped: ${result.stopReason}`)
      return result.output
    }) } finally { for (const [id, value] of this.#sessions) if (value === binding) this.#sessions.delete(id) }
  }
  async *#stream(options: Record<string, unknown>, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    const memory = deepMemoryRequestScope.getStore()
    if (memory) {
      if (options.sessionId !== memory.sessionId || options.provider !== memory.model.provider || options.model !== memory.model.model || options.maxTokens !== memory.maxTokens) throw new Error('Deep memory request route changed')
      const tokens = estimateRequestTokens(Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools })), memory.maxTokens)
      const reservation = await this.store.reserveMemoryRequest(memory.runId, memory.processId, tokens)
      let actual: number | undefined, finished = false
      try { for await (const value of abortableStream(next(), options.signal as AbortSignal | undefined)) { actual = finiteUsage(value) ?? actual; yield value }; finished = true }
      finally { await this.store.settleRequest(memory.runId, reservation, actual, finished) }
      return
    }
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const binding = sessionId ? this.#sessions.get(sessionId) : undefined
    if (!binding) {
      if (sessionId && await this.store.database(db => readExecutionOwner(db, sessionId)?.mode === 'deep-thinker'
        || !!db.prepare('SELECT 1 FROM dsh_deep_attempts WHERE child_session_id=?').get(sessionId))) throw new Error('Deep-owned Session cannot fall back to a normal model request')
      yield* next(); return
    }
    if (options.provider !== binding.model.provider || options.model !== binding.model.model || options.maxTokens !== binding.state.configuration.budget.maxOutputTokensPerRequest) throw new Error('Deep request route or output limit changed')
    const bytes = Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }))
    if (bytes > 524_288) throw new Error('Deep provider input exceeds the bounded request size')
    const reservation = await this.store.reserveRequest(binding.authority, estimateRequestTokens(bytes, binding.state.configuration.budget.maxOutputTokensPerRequest))
    let actual: number | undefined, finished = false
    try {
      for await (const value of abortableStream(next(), options.signal as AbortSignal | undefined)) {
        actual = finiteUsage(value) ?? actual
        yield value
      }
      finished = true
    } finally {
      await this.store.settleRequest(binding.state.runId, reservation, actual, finished)
    }
  }
  dispose(): void { for (const dispose of this.#disposers.reverse()) dispose(); this.#sessions.clear(); this.#parents.clear() }
}
