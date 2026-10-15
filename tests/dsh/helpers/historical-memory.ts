/** Explicit historical-delivery fixture. Native task admission does not retrieve memory. */
import assert from 'node:assert/strict'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { bindMemoryApplication } from '../../../src/memory/application.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import type { CoreTask } from '../../../src/dsh/core/tasks.js'
export async function bindHistoricalMemory(db: SqliteDatabase, task: CoreTask, project: NonNullable<Parameters<typeof queryScopedContextGated>[1]['project']>, root: string) {
  const result = await queryScopedContextGated(db, { project, projectOnly: true, task: task.profile.target ?? task.profile.expected ?? 'source code',
    taskProfile: task.profile, runId: task.runId, limit: 5, characterBudget: 4000 }, () => ({ persist: true, value: null }))
  assert.ok(result.context)
  bindMemoryApplication(db, { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: root }, task.profile, result.context)
  return result.context
}
