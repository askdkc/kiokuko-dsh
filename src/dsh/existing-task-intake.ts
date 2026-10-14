import type { SqliteDatabase } from '../db/adapter.js'
import { LedgerStore } from '../ledger/store.js'
import { assertCapabilityCatalogBinding } from '../akinator/capability-binding.js'
import { getAkinatorStateService } from '../akinator/service.js'
import { readRunIntakeLink } from '../akinator/store.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { DshRunIntakeService } from './run-intake-service.js'
import type { DshIntakeAnswerer, DshUserQuestionAgent } from './intake-questions.js'
import { readTaskSnapshot, type TaskIdentity } from './task-state.js'
import { withImmediateTransaction } from '../db/transaction.js'

/** Continue the existing intake without creating a run or granting execution. */
export async function continueTaskIntake(db: SqliteDatabase, input: TaskIdentity & {
  workspace: string; expectedRevision: number; expectedGeneration: number;
  capabilities: readonly { kind: 'skill' | 'tool'; name: string; description?: string }[];
  signal: AbortSignal; answerer?: DshIntakeAnswerer | undefined; agent?: DshUserQuestionAgent | undefined;
  validateCapabilities?: (() => Promise<void>) | undefined
}) {
  let revision = input.expectedRevision, generation = input.expectedGeneration
  const assertCurrent = () => {
    input.signal.throwIfAborted()
    const task = readTaskSnapshot(db, input)
    if (task.revision !== revision || task.generation !== generation
      || task.pendingStop || task.state === 'Done' || task.state === 'Ignore') throw new Error('Task intake authority changed')
    const run = new LedgerStore(db).readRun(input.taskId)
    if (!run || run.workspace !== input.workspace) throw new Error('Task intake workspace changed')
    assertCapabilityCatalogBinding(run.metadata, input.capabilities)
  }
  assertCurrent()
  const link = readRunIntakeLink(db, { workspace: input.workspace, runId: input.taskId })
  let state = await getAkinatorStateService(db, { workspace: input.workspace, sessionId: link.sessionId })
  while (state.status === 'needs_answer' && state.question && input.answerer) {
    const question = state.question
    const value = await input.answerer.ask(question, input.signal, input.agent)
    await input.validateCapabilities?.()
    assertCurrent()
    withImmediateTransaction(db, () => {
      new DshRunIntakeService(db).answerIntake({ runId: input.taskId,
        idempotencyKey: `task-intake:${canonicalContentHash({ runId: input.taskId, generation, question: question.id, value })}`,
        request: { apiVersion: '1', questionId: question.id, value, capabilities: input.capabilities } },
        { assertBeforeAnswer: assertCurrent })
      // Intake completion can advance the legacy execution status in this same
      // transaction. Only that committed change refreshes our expected version.
      const task = readTaskSnapshot(db, input)
      revision = task.revision; generation = task.generation
    })
    state = await getAkinatorStateService(db, { workspace: input.workspace, sessionId: link.sessionId })
  }
  assertCurrent()
  return { state, link }
}
