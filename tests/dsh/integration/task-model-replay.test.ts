import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { DshTaskWorkflow, type TaskNativeAgent } from '../../../src/dsh/task-state-host.js'
import { recordTaskEvidence, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import type { OnDemandIntake } from '../../../src/dsh/on-demand-intake.js'

const signal = () => new AbortController().signal
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'task-model-replay-')))
  execFileSync('git', ['init', '--quiet', root], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  const runtime = new DshCoreRuntime({ repositoryRoot: root, autoRegisterRepository: true, databasePath: join(root, 'state.sqlite3'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  await runtime.start()
  const agent = { id: 'primary', status: 'idle', session: { id: 'primary-session', seq: 0, header: { cwd: root } }, async whenIdle() {} }
  const agents = new Map<string, TaskNativeAgent>([[agent.id, agent]]), sessions = new Map<string, TaskNativeAgent['session']>([[agent.session.id, agent.session]])
  const changes: TaskSnapshot[] = [], waiters: Array<(task: TaskSnapshot) => void> = [], services: DshTaskWorkflow[] = []
  let stops = 0, skillReads = 0, completions = 0, currentWork = new AbortController(), onStop = () => {}, onComplete = () => {}
  const demand = { controlTask: () => 'Inspect the exact current repository without changing unrelated files.', taskStateChanged() {} } as unknown as OnDemandIntake
  const freshService = () => {
    const service = new DshTaskWorkflow({ runtime, agents, sessions, demand,
      skills: { async snapshot() { skillReads++; return { complete: true, skills: [] } } }, tools: { schemas: () => [] },
      lisp: () => ({ async stopTask() { stops++; currentWork.abort(); onStop() }, async taskJobsIdle() { return true }, taskJobsIdleSync() { return true } }),
      onCompleted() { completions++; onComplete() },
      emit(task) { changes.push(task); for (const waiter of [...waiters]) waiter(task) } })
    services.push(service); return service
  }
  const service = freshService()
  const until = (predicate: (task: TaskSnapshot) => boolean) => new Promise<TaskSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error('Expected task transition was not observed')) }, 5000)
    const check = (task: TaskSnapshot) => { if (predicate(task)) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(task) } }
    waiters.push(check)
  })
  const create = () => service.operate(agent, { operation: 'create', taskType: 'research', request: 'Inspect the exact current repository.' }, signal())
  const submit = (operation: string, task: TaskSnapshot, reason = `Requested ${operation}`, evidence: string[] = []) => ({
    operation, taskId: task.taskId, expectedRevision: task.revision, expectedGeneration: task.generation, reason, evidence,
  })
  return { root, runtime, agent, agents, sessions, changes, service, freshService, until, create, submit,
    get stops() { return stops }, get skillReads() { return skillReads }, get completions() { return completions },
    observeStop(callback: () => void) { onStop = callback }, observeCompletion(callback: () => void) { onComplete = callback },
    newWork() { currentWork = new AbortController(); return currentWork.signal },
    async cleanup() { for (const service of services) service.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }) } }
}

test('model start replay survives service replacement; changed input and stale new calls stay rejected', async () => {
  const f = await fixture()
  try {
    const created = await f.create(), input = f.submit('start', created), execution = { callId: 'start-call', signal: signal() }
    const started = await f.service.modelOperation(f.agent, input, execution), emitted = f.changes.length
    assert.deepEqual(await f.service.modelOperation(f.agent, input, execution), started)
    assert.deepEqual(await f.freshService().modelOperation(f.agent, input, execution), started)
    assert.equal(f.changes.length, emitted, 'a receipt replay must not publish a new state transition')
    await assert.rejects(f.service.modelOperation(f.agent, { ...input, reason: 'Changed reason' }, execution), /different request/)
    const work = f.newWork()
    await assert.rejects(f.service.modelOperation(f.agent, f.submit('ignore', created, 'Stop obsolete task version'), { ...execution, callId: 'new-stale-call' }), /changed|Stale/)
    assert.equal(work.aborted, false); assert.equal(f.stops, 0)
    assert.deepEqual((await f.service.snapshot(f.agent)).task, started)
  } finally { await f.cleanup() }
})

test('concurrent identical model calls commit and publish exactly one transition', async () => {
  const f = await fixture()
  try {
    const created = await f.create(), input = f.submit('start', created), execution = { callId: 'concurrent-start', signal: signal() }
    const count = f.changes.length
    const results = await Promise.all([f.service.modelOperation(f.agent, input, execution), f.service.modelOperation(f.agent, input, execution)])
    assert.deepEqual(results[0], results[1]); assert.equal(f.changes.length, count + 1)
    assert.equal((await f.service.snapshot(f.agent)).task!.revision, created.revision + 1)
  } finally { await f.cleanup() }
})

test('wait receipt replays without another cancellation, even after the task resumes', async () => {
  const f = await fixture(), idle = deferred(), stopped = deferred()
  try {
    await f.create(); const working = await f.service.operate(f.agent, { operation: 'start' }, signal())
    f.agent.status = 'running'; f.agent.whenIdle = () => idle.promise; f.observeStop(stopped.resolve)
    let conclusions = 0
    const input = f.submit('wait', working), execution = { callId: 'wait-call', signal: signal(), concludeTurn() { conclusions++ } }
    const receipt = await f.service.modelOperation(f.agent, input, execution); await stopped.promise
    const emitted = f.changes.length, stopCount = f.stops
    assert.deepEqual(await f.service.modelOperation(f.agent, input, execution), receipt)
    assert.equal(f.changes.length, emitted); assert.equal(f.stops, stopCount); assert.equal(conclusions, 1)
    const pendingEvent = f.until(task => task.state === 'Pending')
    f.agent.status = 'idle'; idle.resolve(); const pending = await pendingEvent
    const resumed = await f.service.operate(f.agent, { operation: 'resume', expected: pending }, signal())
    const work = f.newWork(), afterResume = f.changes.length
    assert.deepEqual(await f.freshService().modelOperation(f.agent, input, execution), receipt)
    assert.equal(work.aborted, false); assert.equal(f.stops, stopCount); assert.equal(f.changes.length, afterResume); assert.equal(conclusions, 1)
    await assert.rejects(f.service.modelOperation(f.agent, input, { ...execution, callId: 'new-obsolete-wait' }), /changed|Stale/)
    assert.equal(work.aborted, false); assert.deepEqual((await f.service.snapshot(f.agent)).task, resumed)
  } finally { idle.resolve(); await f.cleanup() }
})

test('replaying a receipt cannot bypass current native owner or repository identity', async () => {
  const f = await fixture()
  try {
    const created = await f.create(), input = f.submit('start', created), execution = { callId: 'owned-start', signal: signal() }
    const started = await f.service.modelOperation(f.agent, input, execution)
    await assert.rejects(f.service.modelOperation({ ...f.agent }, input, execution), /exact current/)
    const target = { id: 'next', status: 'idle', session: { id: 'next-session', header: { cwd: f.root, parentSession: f.agent.session.id } } }
    f.agents.set(target.id, target); f.sessions.set(target.session.id, target.session)
    const transferred = await f.service.handoff(f.agent, target, started, signal())
    await assert.rejects(f.service.modelOperation(f.agent, input, execution), /owner|repository/)
    assert.deepEqual((await f.service.snapshot(target)).task, transferred)
  } finally { await f.cleanup() }
})

test('model create replay preserves the original receipt without another capability read or run', async () => {
  const f = await fixture()
  try {
    const input = { operation: 'create', taskType: 'research' }, execution = { callId: 'create-call', signal: signal() }
    const created = await f.service.modelOperation(f.agent, input, execution), emitted = f.changes.length, skills = f.skillReads
    assert.equal(created.repositoryRoot, f.root)
    assert.deepEqual(await f.service.modelOperation(f.agent, input, execution), created)
    assert.equal(f.changes.length, emitted); assert.equal(f.skillReads, skills)
    const working = await f.service.operate(f.agent, { operation: 'start' }, signal())
    assert.deepEqual(await f.freshService().modelOperation(f.agent, input, execution), created)
    assert.deepEqual((await f.service.snapshot(f.agent)).task, working)
    await assert.rejects(f.service.modelOperation(f.agent, { ...input, taskType: 'analysis' }, execution), /different request/)
    assert.equal(await f.runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n), 1)
  } finally { await f.cleanup() }
})

test('Done replays its exact verified receipt without repeating native completion', async () => {
  const f = await fixture(), completed = deferred()
  try {
    await f.create(); const working = await f.service.operate(f.agent, { operation: 'start' }, signal())
    await f.runtime.withDatabase(db => recordTaskEvidence(db, working, { ref: 'host-current-proof', kind: 'verification', generation: working.generation, verified: true }))
    f.observeCompletion(completed.resolve)
    const input = f.submit('complete', working, 'Host verified this result', ['host-current-proof']), execution = { callId: 'complete-call', signal: signal() }
    const done = await f.service.modelOperation(f.agent, input, execution); await completed.promise
    const emitted = f.changes.length
    assert.equal(done.state, 'Done')
    f.agent.session.seq = 50
    assert.deepEqual(await f.freshService().modelOperation(f.agent, input, execution), done)
    assert.equal(f.completions, 1); assert.equal(f.changes.length, emitted)
    assert.deepEqual((await f.service.snapshot(f.agent)).task, done)
  } finally { await f.cleanup() }
})
