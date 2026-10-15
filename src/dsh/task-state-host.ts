import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import { withImmediateTransaction } from '../db/transaction.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { executeIdempotentInTransaction } from './intake-idempotency.js'
import { LedgerStore } from '../ledger/store.js'
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js'
import { canonicalContentHash, type JsonValue } from '../serialization/validate.js'
import type { DshCoreRuntime } from './core-runtime.js'
import { resolveGroundedIntakeProfile } from './intake-profile-resolver.js'
import { DshRunIntakeService } from './run-intake-service.js'
import { stableLispCapabilities } from './lisp-service-key.js'
import { observedTaskCompletionEvidence } from './owned-completion-evidence.js'
import { assessTaskCompletion } from './task-completion.js'
import { stopTaskNativeChildren } from './native-task-authority.js'
import { stopTaskOwnedExecutions } from './owned-execution.js'
import { isNativeSubagent } from './native-subagent.js'
import type { LispAssemblyService } from './lisp/request-surface.js'
import type { OnDemandIntake } from './on-demand-intake.js'
import { bindTaskRepository, findSessionTask, readTaskSnapshot, recordTaskEvidence, transitionTask,
  requestTaskStop, confirmTaskStop, transferTaskOwner, TASK_OPERATIONS, TaskSnapshotSchema,
  type TaskIdentity, type TaskOperation, type TaskSnapshot } from './task-state.js'

export const TASK_WORKFLOW_SERVICE = 'kiokukoTaskWorkflow'
export const TASK_STATE_EVENT = 'kiokuko/task-state'
export const TASK_OPERATION_TOOL = 'task_operation'
export interface TaskNativeAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly seq?: number; snapshotEvents?(): readonly { readonly seq: number }[]; readonly header?: { readonly cwd?: string; readonly parentSession?: unknown; readonly origin?: string; readonly delegationDepth?: number } }
  readonly status?: string
  cancel?(cause: { kind: 'hook'; reason: string }): void
  whenIdle?(): Promise<void>
}
export interface TaskExpected { readonly taskId: string; readonly revision: number; readonly generation?: number }
export type TaskUiOperation = { readonly operation: 'create'; readonly request: string; readonly taskType: TaskType }
  | { readonly operation: TaskOperation; readonly reason?: string; readonly evidence?: readonly string[]; readonly expected?: TaskExpected; readonly taskId?: string }
const text = z.string().trim().min(1).max(4096)
export const TaskModelOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), taskType: z.enum(TASK_TYPES) }).strict(),
  ...TASK_OPERATIONS.map(operation => z.object({ operation: z.literal(operation), taskId: text,
    expectedRevision: z.number().int().positive(), expectedGeneration: z.number().int().positive(),
    reason: text, evidence: z.array(text.max(512)).max(32).default([]) }).strict()),
])
interface ModelOperationReplay {
  readonly scope: string
  readonly key: string
  readonly owner: Omit<TaskIdentity, 'taskId'>
  readonly request: JsonValue
  replayed: boolean
}
interface HostOptions {
  runtime: DshCoreRuntime
  demand?: OnDemandIntake
  agents: { get(id: string): unknown }
  sessions: { get(id: string): unknown }
  skills: { snapshot(options: unknown): Promise<any> }
  tools: { schemas(agent: unknown): unknown | PromiseLike<unknown> }
  lisp?: () => Pick<LispAssemblyService, 'stopTask' | 'taskJobsIdle' | 'taskJobsIdleSync'> | undefined
  checkpointSource?(agent: TaskNativeAgent): Promise<void>
  kickFinalizer?(): void
  onCompleted?(task: TaskSnapshot): void
  emit(snapshot: TaskSnapshot): void
}

/** Public adapter over SQLite. It keeps no authoritative task state in memory. */
export class DshTaskWorkflow {
  readonly #stops = new Map<string, Promise<void>>()
  readonly #completions = new Map<string, Promise<void>>()
  readonly #lifecycle = new AbortController()
  #closed = false
  constructor(private readonly options: HostOptions) {}
  private current(agent: TaskNativeAgent): void {
    if (this.#closed || !agent?.session || this.options.agents.get(agent.id) !== agent
      || this.options.sessions.get(agent.session.id) !== agent.session || isNativeSubagent(agent)) {
      throw new KiokukoError('CONFLICT', 'Task operation requires the exact current primary native agent and session')
    }
  }
  private async owner(agent: TaskNativeAgent): Promise<Omit<TaskIdentity, 'taskId'>> {
    this.current(agent)
    if (!agent.session.header?.cwd) throw new KiokukoError('CONFLICT', 'Current native workspace is unavailable')
    const cwd = realpathSync(agent.session.header.cwd)
    const owner = await this.options.runtime.withDatabase(async db => {
      const project = await resolveProjectWorkspaceReadOnly(db, cwd, { allowDirectory: true })
      if (!project) throw new KiokukoError('CONFLICT', 'Current native workspace is not registered')
      return { sessionId: agent.session.id, repositoryRoot: project.repositoryRoot }
    })
    this.current(agent)
    return owner
  }
  async snapshot(agent: TaskNativeAgent): Promise<{ sessionId: string; task: TaskSnapshot | null }> {
    this.current(agent)
    if (!agent.session.header?.cwd) throw new KiokukoError('CONFLICT', 'Current native workspace is unavailable')
    const cwd = realpathSync(agent.session.header.cwd)
    const task = await this.options.runtime.withDatabase(async db => {
      const project = await resolveProjectWorkspaceReadOnly(db, cwd, { allowDirectory: true })
      return project ? findSessionTask(db, { sessionId: agent.session.id, repositoryRoot: project.repositoryRoot }, { includeLatestTerminal: true }) : undefined
    })
    this.current(agent)
    return { sessionId: agent.session.id, task: task ?? null }
  }
  isControl(execution: unknown): boolean {
    if (!execution || typeof execution !== 'object') return false
    try { this.current((execution as { agent: TaskNativeAgent }).agent) } catch { return false }
    return this.options.demand?.isControl(execution as any) === true
  }
  private publish(task: TaskSnapshot): TaskSnapshot { if (!this.#closed) { this.options.demand?.taskStateChanged(task); try { this.options.emit(task) } catch { /* A UI observer cannot roll back a committed operation. */ } } return task }
  /** Durable public-call receipts share the mutation's transaction. Reading a
   * receipt still requires the exact current native owner and repository, but
   * never re-publishes an old snapshot or restarts its lifecycle side effects. */
  private modelReceipt(db: SqliteDatabase, owner: Omit<TaskIdentity, 'taskId'>,
    replay: ModelOperationReplay | undefined, operation?: () => TaskSnapshot): TaskSnapshot | undefined {
    if (!replay) return operation?.()
    if (owner.sessionId !== replay.owner.sessionId || owner.repositoryRoot !== replay.owner.repositoryRoot)
      throw new KiokukoError('CONFLICT', 'Task owner or repository changed')
    const absent = Symbol('no-model-operation-receipt')
    let executed = false
    try {
      return withImmediateTransaction(db, () => {
        const result = TaskSnapshotSchema.parse(executeIdempotentInTransaction(db, {
          scope: replay.scope, key: replay.key, request: replay.request,
        }, () => {
          if (!operation) throw absent
          executed = true
          return operation() as unknown as JsonValue
        }))
        readTaskSnapshot(db, { ...owner, taskId: result.taskId })
        replay.replayed = !executed
        return result
      })
    } catch (error) { if (error === absent) return undefined; throw error }
  }
  private async create(agent: TaskNativeAgent, task: string, type: TaskType, operationId: string, signal: AbortSignal,
    replay?: ModelOperationReplay): Promise<TaskSnapshot> {
    const owner = await this.owner(agent)
    const request = text.max(16384).parse(task), taskType = z.enum(TASK_TYPES).parse(type)
    const grounded = resolveGroundedIntakeProfile({ task: request, cwd: owner.repositoryRoot, deferTaskTypeInference: true, profileHints: { taskType } })
    const skills = await this.options.skills.snapshot({ scope: agent, cwd: owner.repositoryRoot, signal })
    if (!skills.complete) throw new KiokukoError('CONFLICT', 'Native capability inventory is incomplete')
    const schemas = stableLispCapabilities(await this.options.tools.schemas(agent) as any, agent)
    const capabilities = [...skills.skills.filter((skill: any) => skill.invocation?.modelInvocable !== false)
      .map((skill: any) => ({ kind: 'skill', name: skill.name, ...(skill.description ? { description: skill.description } : {}) })),
    ...schemas.map((tool: any) => ({ kind: 'tool', name: tool.name, ...(tool.description ? { description: tool.description } : {}) }))]
    signal.throwIfAborted(); this.current(agent)
    const result = await this.options.runtime.withDatabase(async db => {
      const project = await resolveProjectWorkspaceReadOnly(db, owner.repositoryRoot, { allowDirectory: true })
      if (!project) throw new KiokukoError('CONFLICT', 'Task workspace changed')
      this.current(agent); signal.throwIfAborted()
      return this.modelReceipt(db, owner, replay, () => {
        const current = findSessionTask(db, owner)
        if (current && new LedgerStore(db).readRun(current.runId)?.metadata.requestId !== operationId)
          throw new KiokukoError('CONFLICT', 'A current task already exists; use an allowed operation or finish it before creating another')
        const opened = new DshRunIntakeService(db, { deferTaskTypeInference: true }).openRun({
          idempotencyKey: operationId, dshSessionId: owner.sessionId,
          request: { apiVersion: '1', workspace: project.workspace,
            task: { title: request, query: request, profileHints: grounded.profileHints },
            captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
            capabilities, metadata: { taskStateExplicit: true, requestId: operationId, repositoryRoot: owner.repositoryRoot } } })
        return bindTaskRepository(db, { ...owner, taskId: opened.runId })
      })!
    })
    return replay?.replayed ? result : this.publish(result)
  }
  async operate(agent: TaskNativeAgent, operation: TaskUiOperation, signal: AbortSignal): Promise<TaskSnapshot> {
    return this.apply(agent, operation, signal, { explicit: true, operationId: `task-ui:${randomUUID()}` })
  }
  async modelOperation(agent: TaskNativeAgent, raw: unknown, execution: { callId: string; signal: AbortSignal; concludeTurn?: () => void }): Promise<TaskSnapshot> {
    const input = TaskModelOperationSchema.parse(raw)
    const operation: TaskUiOperation = input.operation === 'create'
      ? { operation: 'create', taskType: input.taskType, request: this.options.demand?.controlTask(execution as any) ?? '' }
      : { operation: input.operation, reason: input.reason, evidence: input.evidence,
        expected: { taskId: input.taskId, revision: input.expectedRevision, generation: input.expectedGeneration } }
    execution.signal.throwIfAborted()
    const owner = await this.owner(agent)
    const replay: ModelOperationReplay = { scope: `task-model:${canonicalContentHash(owner.sessionId)}`,
      key: `task-tool:${execution.callId}`, owner, request: { owner, operation } as unknown as JsonValue, replayed: false }
    const previous = await this.options.runtime.withDatabase(db => this.modelReceipt(db, owner, replay))
    this.current(agent); execution.signal.throwIfAborted()
    if (previous) return previous
    let result: TaskSnapshot
    try {
      result = await this.apply(agent, operation, execution.signal, { explicit: false, operationId: replay.key, replay })
    } catch (error) {
      // A concurrent identical call can commit between our receipt lookup and
      // the ordinary CAS check. Recover only its exact durable receipt.
      execution.signal.throwIfAborted()
      const currentOwner = await this.owner(agent)
      const committed = await this.options.runtime.withDatabase(db => this.modelReceipt(db, currentOwner, replay))
      this.current(agent); execution.signal.throwIfAborted()
      if (!committed) throw error
      return committed
    }
    if (!replay.replayed && result.pendingStop) execution.concludeTurn?.()
    return result
  }
  private async apply(agent: TaskNativeAgent, operation: TaskUiOperation, signal: AbortSignal,
    source: { explicit: boolean; operationId: string; replay?: ModelOperationReplay }): Promise<TaskSnapshot> {
    signal.throwIfAborted()
    if (operation.operation === 'ignore' && !operation.reason?.trim()) throw new KiokukoError('VALIDATION_ERROR', 'Ignore requires an explicit reason')
    if (operation.operation === 'create') return this.create(agent, operation.request, operation.taskType, source.operationId, signal, source.replay)
    const owner = await this.owner(agent)
    const task = await this.options.runtime.withDatabase(db => operation.expected || operation.taskId
      ? readTaskSnapshot(db, { ...owner, taskId: operation.expected?.taskId ?? operation.taskId! })
      : findSessionTask(db, owner, { includeLatestTerminal: true }))
    if (!task) throw new KiokukoError('CONFLICT', 'No task is selected for this session')
    if (operation.expected && (operation.expected.revision !== task.revision
      || operation.expected.generation !== undefined && operation.expected.generation !== task.generation)) throw new KiokukoError('CONFLICT', 'Task changed; read the current snapshot before operating')
    const identity = { ...owner, taskId: task.taskId }
    const input = { operation: operation.operation, operationId: source.operationId, expectedRevision: task.revision,
      expectedGeneration: task.generation, reason: operation.reason ?? `Explicit ${operation.operation} operation`,
      evidence: [...(operation.evidence ?? [])], explicit: source.explicit }
    if (input.operation === 'complete') {
      const lisp = this.options.lisp?.()
      const idle = lisp?.taskJobsIdle ? await lisp.taskJobsIdle(agent)
        : !await this.options.runtime.withDatabase(db => db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(task.sessionId))
      if (!idle) throw new KiokukoError('CONFLICT', 'Task still has running or unconfirmed Lisp work')
    }
    this.current(agent); signal.throwIfAborted()
    const result = await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      this.current(agent); signal.throwIfAborted()
      return this.modelReceipt(db, owner, source.replay, () => {
        if (input.operation === 'complete') {
          const lisp = this.options.lisp?.()
          if (lisp?.taskJobsIdleSync ? !lisp.taskJobsIdleSync(agent)
            : !!db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(task.sessionId))
            throw new KiokukoError('CONFLICT', 'Task still has running or unconfirmed Lisp work')
          if (db.prepare("SELECT 1 FROM dsh_owned_operations WHERE run_id=? AND state='started' LIMIT 1").get(task.taskId))
            throw new KiokukoError('CONFLICT', 'Task still has running owned work; collect its terminal result before completion')
          const assessment = assessTaskCompletion(db, task.runId)
          if (assessment.verified) {
            const ref = `verification:${canonicalContentHash({ taskId: task.taskId, generation: task.generation, assessment })}`
            recordTaskEvidence(db, identity, { ref, kind: 'verification', generation: task.generation, verified: true })
            input.evidence.push(ref)
          } else if (!assessment.coding && assessment.required === 0) {
            const observed = observedTaskCompletionEvidence(db, task, input.evidence)
            if (observed.length > 0) {
              const ref = `verification:${canonicalContentHash({ taskId: task.taskId, generation: task.generation, observed })}`
              recordTaskEvidence(db, identity, { ref, kind: 'verification', generation: task.generation, verified: true,
                details: { source: 'explicit-completion', observationRefs: observed } })
              input.evidence.push(ref)
            }
          }
        }
        return task.state === 'Working' && (input.operation === 'wait' || input.operation === 'ignore')
          ? requestTaskStop(db, identity, input) : transitionTask(db, identity, input,
            { ...(this.sourceEndSeq(agent) === undefined ? {} : { sourceEndSeq: this.sourceEndSeq(agent)! }) })
      })!
    }))
    if (source.replay?.replayed) return result
    this.publish(result)
    if (result.pendingStop) {
      if (source.explicit && agent.status !== 'idle') agent.cancel?.({ kind: 'hook', reason: 'Explicit Kiokuko task stop' })
      this.finishStop(agent, result)
    }
    if (result.state === 'Done') this.finishCompletion(agent, result)
    return result
  }
  private sourceEndSeq(agent: TaskNativeAgent): number | undefined {
    const seq = Number.isSafeInteger(agent.session.seq) && agent.session.seq! > 0
      ? agent.session.seq! - 1 : agent.session.snapshotEvents?.().at(-1)?.seq
    return Number.isSafeInteger(seq) && seq! >= 0 ? seq : undefined
  }
  private async stopWork(agent: TaskNativeAgent, task: TaskSnapshot, signal: AbortSignal): Promise<boolean> {
    // A delayed idle callback or handoff must not stop a later generation.
    // Check before each independently awaited drain, not only before committing
    // the final receipt: cancellation itself is an externally visible effect.
    const assertCurrent = async () => {
      signal.throwIfAborted(); this.current(agent)
      await this.options.runtime.withDatabase(db => {
        const current = readTaskSnapshot(db, task)
        if (current.revision !== task.revision || current.generation !== task.generation)
          throw new KiokukoError('CONFLICT', 'Task changed before stopping its work')
      })
      signal.throwIfAborted(); this.current(agent)
    }
    await assertCurrent()
    const lisp = this.options.lisp?.()
    if (lisp?.stopTask) await lisp.stopTask(agent)
    else {
      // During unload the service may already be unavailable while workers drain.
      // A persisted enabled session cannot be assumed stopped from service absence.
      const enabled = await this.options.runtime.withDatabase(db => db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(task.sessionId))
      if (enabled) return false
    }
    await assertCurrent()
    if (!await stopTaskNativeChildren(this.options.runtime, task, signal)) return false
    await assertCurrent()
    return stopTaskOwnedExecutions(this.options.runtime, task, signal)
  }
  /** A durable pending request survives failure/reload; idle alone is not process-stop proof. */
  finishStop(agent: TaskNativeAgent, task: TaskSnapshot): void {
    if (!task.pendingStop || this.#closed || this.#stops.has(task.taskId)) return
    const operationId = task.pendingStop.operationId
    const promise = (async () => {
      const stopped = await this.stopWork(agent, task, this.#lifecycle.signal)
      if (!stopped || !agent.whenIdle) return
      await agent.whenIdle()
      if (agent.status !== 'idle') return
      this.current(agent)
      await this.options.checkpointSource?.(agent)
      this.current(agent)
      const result = await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
        this.current(agent)
        if (agent.status !== 'idle') return undefined
        const current = readTaskSnapshot(db, task)
        if (current.pendingStop?.operationId !== operationId) return undefined
        const ref = `stopped:${operationId}:${current.generation}`
        recordTaskEvidence(db, task, { ref, kind: 'stopped', generation: current.generation, verified: true })
        const confirmed = confirmTaskStop(db, task, { operationId, expectedRevision: current.revision, evidenceRef: ref })
        return confirmed
      }))
      if (result) this.publish(result)
    })().catch(() => { /* Preserve the durable unresolved stop and its denied authority. */ }).finally(() => this.#stops.delete(task.taskId))
    this.#stops.set(task.taskId, promise)
  }
  /** Wait for the final native answer, then seal only this exact Done generation. */
  finishCompletion(agent: TaskNativeAgent, task: TaskSnapshot): void {
    const key = `${task.taskId}:${task.revision}:${task.generation}`
    if (task.state !== 'Done' || this.#closed || this.#completions.has(key) || !agent.whenIdle) return
    const promise = (async () => {
      await agent.whenIdle!()
      this.current(agent)
      if (agent.status !== 'idle') return
      await this.options.checkpointSource?.(agent)
      this.current(agent)
      const completed = await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
        this.current(agent)
        if (agent.status !== 'idle') return false
        const current = readTaskSnapshot(db, task)
        if (current.state !== 'Done' || current.revision !== task.revision || current.generation !== task.generation) return false
        return true
      }))
      if (completed) try { this.options.onCompleted?.(task) } catch { /* Optional local memory cannot undo completion. */ }
    })().catch(() => { /* A later native idle/reload retries the same canonical Done state. */ })
      .finally(() => this.#completions.delete(key))
    this.#completions.set(key, promise)
  }
  async handoff(source: TaskNativeAgent, target: TaskNativeAgent, expected: TaskExpected, signal: AbortSignal): Promise<TaskSnapshot> {
    const sourceOwner = await this.owner(source), targetOwner = await this.owner(target)
    if (sourceOwner.repositoryRoot !== targetOwner.repositoryRoot || target.session.header?.parentSession !== source.session.id)
      throw new KiokukoError('CONFLICT', 'Task handoff requires a primary continuation in the same repository')
    const selected = await this.options.runtime.withDatabase(db => {
      signal.throwIfAborted(); this.current(source); this.current(target)
      const task = readTaskSnapshot(db, { ...sourceOwner, taskId: expected.taskId })
      if (task.revision !== expected.revision || expected.generation !== undefined && task.generation !== expected.generation
        || task.pendingStop) throw new KiokukoError('CONFLICT', 'Task changed before handoff or its stop is unresolved')
      return task
    })
    const stopped = await this.stopWork(source, selected, signal)
    if (!stopped || source.status !== 'idle') throw new KiokukoError('CONFLICT', 'Task source has not confirmed its stop')
    signal.throwIfAborted(); this.current(source); this.current(target)
    const result = await this.options.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      signal.throwIfAborted(); this.current(source); this.current(target)
      if (source.status !== 'idle') throw new KiokukoError('CONFLICT', 'Task source resumed before handoff')
      const task = readTaskSnapshot(db, { ...sourceOwner, taskId: expected.taskId })
      if (task.revision !== expected.revision || expected.generation !== undefined && task.generation !== expected.generation)
        throw new KiokukoError('CONFLICT', 'Task changed before handoff')
      const ref = `handoff-stop:${randomUUID()}`
      recordTaskEvidence(db, task, { ref, kind: 'stopped', generation: task.generation, verified: true })
      return transferTaskOwner(db, task, { sessionId: targetOwner.sessionId, operationId: `handoff:${randomUUID()}`,
        expectedRevision: task.revision, expectedGeneration: task.generation, evidence: [ref], reason: 'Trusted native primary continuation handoff',
        ...(this.sourceEndSeq(source) === undefined ? {} : { sourceEndSeq: this.sourceEndSeq(source)! }) })
    }))
    return this.publish(result)
  }
  dispose(): void { this.#closed = true; this.#lifecycle.abort(new Error('Task workflow disposed')) }
}
