import type { DecisionService } from '../decisions/service.js'
import { createMemoryReuseRuntime } from '../memory-reuse.js'
import { readContextRunRetrievalState } from '../../context/run-state.js'
import { classifyTask, selectInstalledSkills } from '../decisions/workflows.js'
import { legacyModuleRequirements } from '../modules/legacy-bindings.js'
import { realpathSync } from 'node:fs'
import { canonicalContentHash } from '../../serialization/validate.js'
import { DshRunIntakeService } from '../run-intake-service.js'
import { getAkinatorStateService } from '../../akinator/service.js'
import { hasBlockingRequiredCapability, resolveCapabilities, deriveMemoryPolicy } from '../../akinator/capabilities.js'
import { resolveGroundedIntakeProfile } from '../intake-profile-resolver.js'
import { resolveProjectWorkspaceReadOnly } from '../../memory/workspaces.js'
import { recallScopedMemory, checkpointDshMemory, type ScopedCheckpointInput } from '../../memory/scoped-memory.js'
import { LedgerStore } from '../../ledger/store.js'
import { TERMINAL_RUN_STATUSES } from '../../ledger/types.js'
import { claimExecutionOwner, readExecutionOwner } from '../orchestration/execution-owner.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import type { SqliteDatabase } from '../../db/adapter.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshIntakeAnswerer, DshUserQuestionAgent } from '../intake-questions.js'
import type { TaskProfile } from '../../akinator/types.js'

export interface CoreTaskInput {
  readonly requestId: string
  readonly sessionId: string
  readonly turn: number
  readonly task: string
  readonly cwd: string
  readonly capabilities: readonly { kind: 'skill' | 'tool'; name: string; description?: string }[]
  readonly profileHints?: Partial<TaskProfile>
  readonly signal: AbortSignal
  readonly agent?: DshUserQuestionAgent
}
export interface CoreTask {
  readonly requestId: string
  readonly sessionId: string
  readonly runId: string
  readonly workspace: string
  readonly cwd: string
  readonly profile: TaskProfile
  readonly memory: unknown
  readonly selectedSkills?: readonly string[]
  readonly admitted: boolean
}

type CoreTaskIdentity = Pick<CoreTask, 'requestId' | 'sessionId' | 'runId' | 'workspace'>
type CoreTaskOutcome = (typeof TERMINAL_RUN_STATUSES)[number]

/** Close the exact run and release its owner atomically, including pre-admission failures. */
function finishCoreTask(db: SqliteDatabase, task: CoreTaskIdentity, outcome: CoreTaskOutcome): void {
  withImmediateTransaction(db, () => {
    const store = new LedgerStore(db), run = store.readRun(task.runId)
    if (!run || run.workspace !== task.workspace || run.dshSessionId !== task.sessionId) throw new Error('Task completion identity mismatch')
    const owner = readExecutionOwner(db, task.sessionId)
    if (owner && (owner.run_id !== task.runId || owner.start_id !== task.requestId || owner.workspace !== task.workspace || owner.mode !== 'normal')) throw new Error('Task completion owner mismatch')
    if (run.status === 'active' || run.status === 'intake' && outcome !== 'completed') store.updateRunStatusInTransaction(task.runId, outcome)
    else if (!TERMINAL_RUN_STATUSES.some(status => status === run.status)) throw new Error('Task is not ready for completion')
    db.prepare("DELETE FROM dsh_execution_owners WHERE dsh_session_id=? AND run_id=? AND start_id=? AND workspace=? AND mode='normal'").run(task.sessionId, task.runId, task.requestId, task.workspace)
  })
}

/** Ordinary task/memory path over the existing ledger and Akinator; no model/provider selection. */
export class CoreTasks {
  constructor(private readonly runtime: DshCoreRuntime, private readonly answerer?: DshIntakeAnswerer, private readonly moduleIds: readonly string[] = [], private readonly decisions?: DecisionService) {}
  async prepare(input: CoreTaskInput): Promise<CoreTask> {
    input.signal.throwIfAborted()
    const cwd = realpathSync(input.cwd)
    const taskType = await classifyTask(this.decisions, input.requestId, input.task, input.profileHints?.taskType, input.signal)
    const grounded = resolveGroundedIntakeProfile({ task: input.task, cwd, profileHints: { ...input.profileHints, ...(taskType ? { taskType } : {}) } })
    return this.runtime.withDatabase(async db => {
      for (const id of legacyModuleRequirements(db, input.sessionId)) {
        if (!this.moduleIds.includes(id)) throw new Error(`Required module unavailable for persisted session: ${id}`)
      }
      const project = await resolveProjectWorkspaceReadOnly(db, cwd, { allowDirectory: true })
      if (!project) throw new Error('Task workspace is not registered')
      const intake = new DshRunIntakeService(db, {
        onRunCreatedInTransaction: ({ database, runId }) => claimExecutionOwner(database, { sessionId: input.sessionId, workspace: project.workspace, mode: 'normal', startId: input.requestId, runId }),
      })
      const opened = intake.openRun({ idempotencyKey: `core:${canonicalContentHash({ requestId: input.requestId, sessionId: input.sessionId })}`, dshSessionId: input.sessionId,
        request: { apiVersion: '1', workspace: project.workspace, task: { title: input.task, query: input.task, profileHints: grounded.profileHints }, captureProfile: 'minimal',
          coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
          capabilities: input.capabilities, metadata: { coreContractVersion: 1, requestId: input.requestId, repositoryRoot: project.repositoryRoot } } })
      const identity = { requestId: input.requestId, sessionId: input.sessionId, runId: opened.runId, workspace: project.workspace }
      try {
        input.signal.throwIfAborted()
        let state = await getAkinatorStateService(db, { workspace: project.workspace, sessionId: opened.intakeSessionId })
        while (state.status === 'needs_answer' && state.question && this.answerer) {
          const question = state.question
          const value = await this.answerer.ask(question, input.signal, input.agent)
          input.signal.throwIfAborted()
          intake.answerIntake({ runId: opened.runId, idempotencyKey: `core-answer:${canonicalContentHash({ runId: opened.runId, question: question.id, value })}`,
            request: { apiVersion: '1', questionId: question.id, value, capabilities: input.capabilities } })
          state = await getAkinatorStateService(db, { workspace: project.workspace, sessionId: opened.intakeSessionId })
        }
        const capabilities = resolveCapabilities({ task: input.task, profile: state.session.profile, recommendedTags: [], capabilities: input.capabilities, memoryUse: 'none' })
        const run = new LedgerStore(db).readRun(opened.runId)
        const admitted = state.status !== 'needs_answer' && run?.status === 'active' && !hasBlockingRequiredCapability(capabilities)
        const admissionState = admitted ? readContextRunRetrievalState(db, opened.runId).stateHash : null
        const selectedSkills = admitted ? await selectInstalledSkills(this.decisions, input.requestId, input.task, input.capabilities, capabilities, input.signal) : []
        let memory: unknown = null
        if (admitted) {
          const policy = deriveMemoryPolicy(state.session.profile, 'actionable', input.capabilities)
          if (!policy.contextWithheld) {
            const memoryReuse = await createMemoryReuseRuntime(this.decisions, input.requestId, input.signal)
            const assertCurrent = () => {
              input.signal.throwIfAborted()
              if (readContextRunRetrievalState(db, opened.runId).stateHash !== admissionState) throw new Error('Core task changed during memory selection')
              const owner = readExecutionOwner(db, input.sessionId)
              if (owner?.run_id !== opened.runId || owner.start_id !== input.requestId || owner.mode !== 'normal') throw new Error('Core task memory ownership changed')
            }
            assertCurrent()
            memory = await recallScopedMemory(db, { cwd, project, query: input.task, scope: 'project', limit: 5, maxChars: 4000, readOnly: true }, {},
              memoryReuse ? { runtime: memoryReuse, constraints: state.session.profile.constraints ?? '', assertCurrent } : undefined)
          }
        }
        input.signal.throwIfAborted()
        return Object.freeze({ ...identity, cwd, profile: state.session.profile, admitted, memory, selectedSkills })
      } catch (error) {
        try { finishCoreTask(db, identity, input.signal.aborted ? 'cancelled' : 'failed') }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Task preparation and cleanup failed') }
        throw error
      }
    })
  }
  async checkpoint(task: CoreTask, input: { memories?: unknown; evidence?: unknown; outcome: string }, signal: AbortSignal): Promise<unknown> {
    if (!task.admitted) throw new Error('Task is not admitted')
    return this.runtime.withDatabase(async db => {
      const run = new LedgerStore(db).readRun(task.runId)
      const owner = readExecutionOwner(db, task.sessionId)
      if (run?.workspace !== task.workspace || run.dshSessionId !== task.sessionId || owner?.run_id !== task.runId || owner.start_id !== task.requestId || owner.mode !== 'normal') throw new Error('Task checkpoint identity mismatch')
      return checkpointDshMemory(db, { ...input, runId: task.runId, cwd: task.cwd } as ScopedCheckpointInput, signal, { allowDirectory: true })
    })
  }
  async finish(task: CoreTask, outcome: CoreTaskOutcome): Promise<void> {
    if (!task.admitted && outcome === 'completed') throw new Error('Task is not admitted')
    await this.runtime.withDatabase(db => finishCoreTask(db, task, outcome))
  }
}
