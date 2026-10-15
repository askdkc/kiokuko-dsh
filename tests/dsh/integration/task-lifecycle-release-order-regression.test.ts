import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
import { authorizeTaskLease, bindTaskRepository, captureTaskLease, readTaskSnapshot, transitionTask, type TaskLease } from '../../../src/dsh/task-state.js'
// The original task-completion assertions run as their own file in the official integration suite.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const cacheFault of [false, true]) test(`deferred cache ${cacheFault ? 'failure' : 'success'} is never invoked and cannot retire a resumed owner`, { timeout: 15_000 }, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'task-close-resume-')))
  const root = join(base, 'repo')
  await mkdir(root)
  execFileSync('git', ['init', '--quiet', root], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  const db = openConnection(join(base, 'state.sqlite3'))
  const entered = deferred(), release = deferred()
  let closing: Promise<void> | undefined
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(db, { requestId: 'release-before-cache', cwd: root,
      task: 'Read the repository and report observed results.', dshSessionId: 'source-session',
      profileHints: { taskType: 'research', target: 'repo', expected: 'report', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })
    const identity = { taskId: prepared.run.runId, sessionId: 'source-session', repositoryRoot: root }
    bindTaskRepository(db, identity)
    const authority = captureTaskLease(db, identity)
    const session = { id: identity.sessionId }, agent = { id: 'native-agent', session }
    const item: any = { runId: identity.taskId, sessionId: identity.sessionId, agentId: agent.id,
      workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
      repositoryRoot: root, cwd: root, task: 'Read the repository', turn: 1, prepared, authority,
      nativeSession: session, nativeAgent: agent, failed: false, closed: false }
    let turns = [item], currentWork = new AbortController()
    const oldWork = currentWork
    const effects: string[] = []
    const runtime: any = { withDatabase: async (fn: (database: typeof db) => unknown) => fn(db) }
    const finalizer = new DshMemoryFinalizer({ runtime })
    await finalizer.bindRunStart({ runId: identity.taskId, workspace: item.workspace,
      dshSessionId: identity.sessionId, sourceStartSeq: 0, sourceStartTurn: 1 })
    finalizer.kick = () => { effects.push('kick') }
    const lifecycle = createLifecycle({ runtime, sessions: undefined,
      sessionMirror: { async markUnfinalized(id: string) {
        assert.equal(id, identity.sessionId)
        effects.push('cache-enter'); entered.resolve(); await release.promise
        effects.push('cache-settle')
        if (cacheFault) throw new Error('delayed auxiliary cache failure')
      } } as any,
      memoryFinalizer: finalizer,
      autoReview: { worker: { abort: () => effects.push('abort-review') } } as any,
      answerReview: { finish: async () => { effects.push('finish-review') } } as any,
      ennoController: { retire: () => effects.push('retire') } as any,
      ennoMemory: { clear: () => effects.push('clear-memory') } as any,
      executionSupport: { clear: () => effects.push('clear-execution') } as any,
      gate: { clearTurn: () => effects.push('clear-turn') } as any,
      turnState: { allTurns: () => turns, releaseRun(_runId: string, closedAuthority: TaskLease) {
        effects.push('release-run')
        turns = turns.filter(turn => turn.authority.generation !== closedAuthority.generation)
      } } as any,
      getSelection: () => undefined, currentSession: () => turns.at(-1), currentForAgentEvent: () => turns.at(-1),
      stateForRun: () => prepared.ennoOduno, deliverCompletionReport: async () => undefined,
      reviewBinding: () => ({} as any), evolutionConfig: { mode: 'off' } as any,
      clearToolRun: () => { effects.push('clear-tools'); currentWork.abort() }, sessionEventSource: () => ({} as any) })
    const close = { runId: identity.taskId, status: 'completed' as const, authority, sourceEndSeq: 4, terminalTurn: 1 }
    closing = lifecycle.runLifecycle.closeTurn(close)
    await closing
    assert.equal(effects.includes('cache-enter'),false,'Native completion never invokes optional memory cache finalization')
    // The cache is deliberately unresolved here; retirement must already be complete.
    assert.equal(item.closed, true)
    assert.equal(turns.length, 0)
    assert.equal(oldWork.signal.aborted, true)
    assert.ok(effects.indexOf('release-run') >= 0)
    assert.equal(db.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id=?').get(identity.taskId)?.status, undefined)
    const terminal = readTaskSnapshot(db, identity)
    assert.equal(terminal.runStatus, 'completed')
    const resumed = transitionTask(db, identity, { operation: 'resume', operationId: 'explicit-reopen',
      expectedRevision: terminal.revision, expectedGeneration: terminal.generation,
      reason: 'User explicitly resumes the same task.', explicit: true })
    assert.equal(resumed.state, 'Working'); assert.equal(resumed.runStatus, 'active')
    const nextAuthority = captureTaskLease(db, identity)
    assert.ok(nextAuthority.generation > authority.generation)
    const next = { ...item, turn: 2, authority: nextAuthority, closed: false }
    turns = [next]; currentWork = new AbortController()
    const cleanupAtResume = effects.filter(event => !event.startsWith('cache')).length
    release.resolve(); await closing
    assert.equal(currentWork.signal.aborted, false, 'old completion must not cancel current resumed work')
    assert.equal(next.closed, false); assert.deepEqual(turns, [next])
    assert.deepEqual(authorizeTaskLease(db, nextAuthority), resumed)
    assert.equal(effects.filter(event => !event.startsWith('cache') && event !== 'kick').length, cleanupAtResume)
    assert.equal(effects.filter(event => event === 'kick').length, 0)
    const archived=db.prepare('SELECT source_session_id,boundary_json,finalization_json FROM dsh_task_source_history WHERE run_id=?').get<any>(identity.taskId)!
    assert.equal(archived.source_session_id,identity.sessionId);assert.equal(archived.boundary_json,null);assert.equal(archived.finalization_json,null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_task_source_finalizations').get<any>()!.n,0)
    assert.equal(db.prepare('SELECT 1 FROM dsh_memory_finalizations WHERE run_id=?').get(identity.taskId),undefined)
    const settledEffects = [...effects]
    await lifecycle.runLifecycle.closeTurn(close)
    assert.deepEqual(effects, settledEffects, 'terminal replay must have no new effects')
    assert.deepEqual(authorizeTaskLease(db, nextAuthority), resumed)
    await lifecycle.runLifecycle.dispose()
  } finally {
    release.resolve(); await closing?.catch(() => undefined)
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
