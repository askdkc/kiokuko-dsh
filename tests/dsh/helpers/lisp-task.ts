import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { bindTaskRepository, transitionTask } from '../../../src/dsh/task-state.js'
import type { LispOwner } from '../../../src/dsh/lisp/contracts.js'

/** Full production schema and ordinary task transitions, shared by standalone
 * Lisp fixtures which intentionally exercise managed effects. */
export function workingLispTask(db: SqliteDatabase, owner: LispOwner, key = owner.sessionId) {
  migrateDatabase(db)
  const opened = new DshRunIntakeService(db).openRun({ idempotencyKey: `lisp-task-${key}`, dshSessionId: owner.sessionId,
    request: { apiVersion: '1', workspace: 'project:lisp-tests',
      task: { title: 'Lisp boundary test', query: 'Verify Lisp task execution boundaries',
        profileHints: { taskType: 'research', target: '.', expected: 'report', constraints: null } },
      captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      metadata: { taskStateExplicit: true } } })
  const identity = { taskId: opened.runId, sessionId: owner.sessionId, repositoryRoot: owner.root }
  const task = bindTaskRepository(db, identity)
  return transitionTask(db, identity, { operation: 'start', operationId: `lisp-start-${key}`, expectedRevision: task.revision,
    reason: 'Standalone Lisp effect fixture', evidence: [] })
}
