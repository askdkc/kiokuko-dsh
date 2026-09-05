import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DshExecutionSupport, type ExecutionBinding } from '../../../src/dsh/execution-support.js'
import { updateExecutionFrame, executionPathDenial, executionProposals, saveExecutionFrame, readExecutionFrame } from '../../../src/dsh/execution-frame.js'
import { evidencePresentation } from '../../../src/dsh/exploration.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-execution-'))
  await mkdir(join(root, 'src'))
  await initializeDatabase({ databasePath: join(root, 'state.sqlite3') })
  const db = openConnection(join(root, 'state.sqlite3'))
  const task = '資料を調査して報告する。\nread paths: src\nwrite paths: src\n変更禁止: src/private\n完了条件: 根拠を示す。'
  const prepared = await prepareAgentTask(db, { requestId: 'execution', cwd: root, task, dshSessionId: 'session',
    profileHints: { taskType: 'research', target: 'src', expected: '根拠付きの報告', constraints: null }, capabilities: [], skillDiscoveryMode: 'off' })
  let fail = false
  let wait: Promise<void> | undefined
  const runtime = { async withDatabase<T>(fn: (database: typeof db, runtime: any) => T | Promise<T>): Promise<T> {
    if (wait) await wait
    if (fail) throw new Error('injected DB failure')
    return fn(db, undefined)
  } }
  const session = { id: 'session', snapshotEvents: () => [] }
  const agent = { session }
  const binding: ExecutionBinding = { runId: prepared.run.runId, sessionId: session.id, nativeSession: session, nativeAgent: agent,
    cwd: root, task, turn: 1, generation: 'work-lease-1', terminal: false, chat: false }
  const support = new DshExecutionSupport(runtime)
  const callbacks = new Map<string, Function>()
  let guard!: (execution: any) => string | undefined
  support.mount({ on(name, fn) { callbacks.set(name, fn); return () => { callbacks.delete(name) } },
    tools: { guard(fn) { guard = fn; return () => undefined } } })
  await support.refresh(binding, true)
  const result = { isError: false, content: [{ type: 'text', text: 'facts' }] }
  function read(id: string, overrides: object = {}) {
    const execution = { name: 'read', arguments: { file_path: 'src/facts.md' }, agent, callId: id, rootCallId: 'parent', ...overrides }
    const denied = guard(execution)
    if (!denied) callbacks.get('tools/result')!(execution, result)
    return denied
  }
  const assemble = () => callbacks.get('system-prompt/assemble')!({}, { scope: agent }, async () => ({ contexts: [], variables: {}, sections: [] }))
  const stream = (messages: any[] = []) => callbacks.get('llm/stream')!({ sessionId: 'session', messages }, () => 'original-stream')
  return { root, db, runtime, support, binding, agent, callbacks, guard, read, assemble, stream, result,
    fail(value: boolean) { fail = value }, wait(value: Promise<void> | undefined) { wait = value },
    async close() { support.dispose(); db.close(); await rm(root, { recursive: true, force: true }) } }
}

test('only explicit unquoted labels grant scope; proposals cannot widen it, including symlink creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-frame-'))
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'src/link'))
    const frame = updateExecutionFrame(undefined, root, '日本語\nread paths: src\nwrite paths: src\n> write paths: outside\n```\nwrite paths: outside\n```\n変更禁止: src/private\n完了条件:\n- 改行を保つ\n- 最後に報告する')
    assert.equal(frame.conditions.length, 5)
    assert.equal(executionPathDenial(frame, 'write', ['src/new']), undefined)
    assert.match(executionPathDenial(frame, 'write', ['src/link/new'])!, /outside/)
    assert.match(executionPathDenial(frame, 'write', ['src/private/new'])!, /outside/)
    assert.match(executionPathDenial(frame, 'read', ['../escape'])!, /outside/)
    frame.conditions.push(...executionProposals([{ field: 'writePaths', text: '.', quote: '日本語', revision: 999, id: 'forged' }], frame.objective, 7)
      .map(item => ({ ...item, approval: 'approved' as const })))
    assert.match(executionPathDenial(frame, 'write', ['outside/new'])!, /outside/)
    assert.equal(updateExecutionFrame(frame, root, '続けて').revision, frame.revision)
    assert.equal(executionProposals([{ field: 'constraints', text: 'untrusted', quote: 'not in request' }], frame.objective, 7).length, 0)
    const long = updateExecutionFrame(undefined, root, `長文${'あ'.repeat(40_000)}\n変更禁止:\n${Array.from({ length: 270 }, (_, i) => `- src/${i}`).join('\n')}`)
    assert.equal(long.conditions.length, 270, 'never silently truncate explicit prohibitions')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('repeat correction, duplicate replay, parallel children, durable pause and human resume', async () => {
  const f = await fixture()
  try {
    for (const id of ['a', 'b', 'c', 'd']) f.read(id)
    f.read('a')
    await f.assemble()
    assert.match(f.support.text('session'), /three times/)
    let notices = 0
    assert.equal(await f.support.pauseAtBoundary('session', async () => { notices++ }), false, 'same parallel group has not seen the correction yet')
    assert.equal(f.stream(), 'original-stream')
    f.read('e'); await f.assemble()
    assert.equal(await f.support.pauseAtBoundary('session', async () => { notices++ }), true)
    assert.equal(await f.support.pauseAtBoundary('session', async () => { notices++ }), true)
    assert.equal(notices, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 5)
    const status = f.db.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get(f.binding.runId)
    assert.equal(status?.status, 'active')
    const restarted = new DshExecutionSupport(f.runtime)
    await restarted.refresh(f.binding, false)
    assert.equal(restarted.paused('session'), true)
    const revision = readExecutionFrame(f.db, f.binding.runId)!.revision
    await restarted.refresh({ ...f.binding, turn: 2, task: '対象を絞って続行' }, true)
    assert.equal(restarted.paused('session'), false)
    assert.equal(readExecutionFrame(f.db, f.binding.runId)!.revision, revision)
    restarted.dispose()
    await f.support.refresh({ ...f.binding, generation: 'work-lease-2' }, false)
    f.read('retry'); await f.assemble()
    assert.doesNotMatch(f.support.text('session'), /three times/)
  } finally { await f.close() }
})

test('operation refusal preserves reports, unsupported tools, other sessions, and original successful results', async () => {
  const f = await fixture()
  try {
    assert.match(f.guard({ name: 'write', arguments: { file_path: '../outside' }, agent: f.agent, callId: 'write' })!, /outside/)
    for (const name of ['enno_work_report', 'enno_finish', 'enno_meditation_submit', 'enno_answer', 'shell', 'memory_checkpoint']) {
      assert.equal(f.guard({ name, arguments: { file_path: '../outside' }, agent: f.agent, callId: name }), undefined)
    }
    assert.equal(f.guard({ name: 'write', arguments: { file_path: '../outside' }, agent: { session: { id: 'other' } }, callId: 'other' }), undefined)
    const before = structuredClone(f.result)
    f.read('ok'); f.fail(true); await f.assemble()
    assert.deepEqual(f.result, before)
    assert.match(f.support.text('session'), /degraded/)
    assert.match(f.guard({ name: 'read', arguments: { file_path: 'src/facts.md' }, agent: f.agent, callId: 'unavailable' })!, /unavailable/)
    assert.equal(await f.support.pauseAtBoundary('session', async () => { throw new Error('must not notify') }), false)
    f.fail(false); await f.assemble()
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 1)
  } finally { await f.close() }
})

test('approval binds the exact shown proposals; optional malformed metadata never replaces user conditions', async () => {
  const f = await fixture()
  try {
    await f.support.proposals('session', [{ field: 'constraints', text: 'Use evidence', quote: '資料を調査' }], 2)
    assert.equal(f.support.confirmation('session', 2).length, 1)
    await f.support.proposals('session', [{ field: 'constraints', text: 'A changed proposal', quote: '資料を調査' }], 2)
    await f.support.approve('session', 2)
    assert.equal(readExecutionFrame(f.db, f.binding.runId)!.conditions.filter(item => item.approval === 'approved').length, 0)
    f.support.confirmation('session', 2); await f.support.approve('session', 2)
    assert.equal(readExecutionFrame(f.db, f.binding.runId)!.conditions.filter(item => item.approval === 'approved').length, 1)
    await f.support.proposals('session', { malformed: true }, 2)
    assert.equal(executionPathDenial(readExecutionFrame(f.db, f.binding.runId)!, 'read', ['src/x']), undefined)
  } finally { await f.close() }
})

test('native snapshot is refreshed at intake, retains other context and treats user braces as data', async () => {
  const f = await fixture()
  try {
    const user = { id: 'user', role: 'user', content: [{ type: 'text', text: '日本語\n{{not_a_variable}}' }], source: { kind: 'user' } }
    const snapshot = { id: 'native', role: 'user', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'other', text: 'Other current context' }] } }
    await f.support.refresh({ ...f.binding, task: f.binding.task + '\n{{not_a_variable}}' }, true)
    const projected = f.support.projectMessages('session', [user, snapshot])
    assert.equal(projected[0], user)
    assert.equal(projected.length, 2)
    assert.equal(projected[1].source.sections.length, 2)
    assert.match(projected[1].content[0].text, /Other current context/)
    const again = f.support.projectMessages('session', projected)
    assert.equal(again.length, 2)
    assert.equal(again[1].source.sections.filter((item: any) => item.name === 'kiokuko:execution').length, 1)
    let calls = 0
    const original = { contexts: [], variables: {}, sections: [] }
    f.fail(true)
    await f.callbacks.get('system-prompt/assemble')!({}, { scope: f.agent }, async () => { calls++; return original })
    assert.equal(calls, 1)
    assert.equal(f.stream(), 'original-stream')
  } finally { await f.close() }
})

test('failed notice save, concurrent human input and unload cannot leave an invisible pause', async () => {
  const f = await fixture()
  try {
    for (const id of ['a', 'b', 'c']) f.read(id)
    await f.assemble(); f.stream(); f.read('d'); await f.assemble()
    assert.equal(await f.support.pauseAtBoundary('session', async () => { throw new Error('flush failed') }), false)
    f.read('e'); await f.assemble()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const pausing = f.support.pauseAtBoundary('session', () => wait)
    await f.support.refresh({ ...f.binding, turn: 2, task: '続行' }, true)
    release()
    assert.equal(await pausing, false)
    for (const id of ['f', 'g', 'h']) f.read(id)
    await f.assemble(); f.stream(); f.read('i'); await f.assemble()
    let finish!: () => void
    const last = f.support.pauseAtBoundary('session', () => new Promise(resolve => { finish = resolve }))
    f.support.dispose(); finish(); assert.equal(await last, false)
  } finally { await f.close() }
})

test('evidence distinguishes final request coverage, missing children and truncated acquisition without changing success', async () => {
  const f = await fixture()
  try {
    f.read('full'); f.read('child'); await f.assemble()
    f.stream([{ content: [{ type: 'tool-result', toolCallId: 'full', content: f.result.content }] }])
    await Promise.resolve()
    assert.match(f.support.text('session'), /: full/)
    assert.match(f.support.text('session'), /: unknown/)
    assert.equal(evidencePresentation('Output capped at 8192 bytes', canonicalContentHash('Output capped at 8192 bytes')), 'partial')
    assert.equal(evidencePresentation('changed', canonicalContentHash('original')), 'unknown')
    await f.support.refresh({ ...f.binding, terminal: true }, false)
    const count = f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n
    f.read('after-terminal'); await f.assemble()
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, count)
    assert.match(f.support.text('session'), /Terminal state/)
    assert.equal(await f.support.pauseAtBoundary('session', async () => { throw new Error('terminal must not pause') }), false)
  } finally { await f.close() }
})

test('failed evidence transaction rolls back counters and retries each pending event once', async () => {
  const f = await fixture()
  try {
    f.db.prepare("CREATE TRIGGER reject_optional_evidence BEFORE INSERT ON dsh_execution_evidence BEGIN SELECT RAISE(ABORT, 'injected evidence failure'); END").run()
    f.read('once'); await f.assemble()
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 0)
    f.db.prepare('DROP TRIGGER reject_optional_evidence').run()
    await f.assemble(); f.read('once'); await f.assemble()
    const monitor = JSON.parse(f.db.prepare('SELECT state_json AS json FROM dsh_exploration_states').get<{ json: string }>()!.json)
    assert.equal(monitor.total, 1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 1)
  } finally { await f.close() }
})

test('distinct human steering within one native turn resets monitoring and updates explicit conditions', async () => {
  const f = await fixture()
  try {
    await f.support.refresh({ ...f.binding, humanInput: 'first-input' }, true)
    for (const id of ['a', 'b', 'c']) f.read(id)
    await f.assemble(); f.stream(); f.read('d'); await f.assemble()
    assert.equal(await f.support.pauseAtBoundary('session', async () => undefined), true)
    await f.support.refresh({ ...f.binding, task: '変更禁止: src', humanInput: 'steered-input' }, true)
    assert.equal(f.support.paused('session'), false)
    assert.match(f.guard({ name: 'write', arguments: { file_path: 'src/now-forbidden' }, agent: f.agent, callId: 'after-steering' })!, /outside/)
    const getEpoch = () => JSON.parse(f.db.prepare('SELECT state_json AS json FROM dsh_exploration_states').get<{ json: string }>()!.json).humanEpoch
    const epoch = getEpoch()
    await f.support.refresh({ ...f.binding, task: '変更禁止: src', humanInput: 'steered-input' }, true)
    assert.equal(getEpoch(), epoch, 'replayed input does not open another monitoring generation')
  } finally { await f.close() }
})

test('a late result from a prior human generation cannot affect the resumed exploration', async () => {
  const f = await fixture()
  try {
    const old = { agent: f.agent, name: 'read', arguments: { file_path: 'src/facts' }, callId: 'delayed' }
    f.guard(old)
    await f.support.refresh({ ...f.binding, turn: 2, task: '続行' }, true)
    f.callbacks.get('tools/result')!(old, f.result)
    await f.assemble()
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 0)
    f.read('new'); await f.assemble()
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get<{ n: number }>()!.n, 1)
  } finally { await f.close() }
})
