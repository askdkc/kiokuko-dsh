import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { renderResult, RESULT_BYTES, LispConfig, digest } from '../../../../src/dsh/lisp/contracts.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispProposalBatch } from '../../../../src/dsh/lisp/proposal-batch.js'
import { inspectSavedResult } from '../../../../src/dsh/lisp/inspection.js'
import { createLispCiAdapter, describeVerifiers } from '../../../../src/dsh/lisp/ci.js'
import { confirm } from '../../../../src/dsh/lisp/approval.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-eff-'))), root = join(base, 'work')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  t.after(async () => { db.close(); await rm(base, { recursive: true, force: true }) })
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 's', agentId: 'a', root }
  await store.enable(owner)
  return { base, root, store, owner }
}
const allowed: DshUserQuestions = { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: [request.questions[0].intent!.approve] }] }) }

test('model result omits source echoes, preserves outcomes and reduces log-shaped batches over 80%', () => {
  for (const count of [13, 21]) {
    const raw = { ok: true, operationId: 'op', generation: 'g', value: { printed: 'duplicate-value', json: ['changed'], ref: 'g/1' },
      proposals: Array.from({ length: count }, (_, i) => ({ operation: 'write', path: `src/${i}.ts`, content: '日本語🙂 source\n'.repeat(900) })),
      changes: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, path: `src/${i}.ts`, state: i === 0 ? 'NOT_APPLIED' : 'APPLIED', ...(i === 0 ? { reason: 'declined' } : {}) })) }
    const unchanged = JSON.stringify(raw), current = renderResult(raw)
    const baseline = JSON.stringify({ truncated: true, preview: Buffer.from(unchanged).subarray(0, 12000).toString('utf8') })
    const result = JSON.parse(current)
    assert.ok(Buffer.byteLength(current) <= RESULT_BYTES)
    assert.ok(Buffer.byteLength(current) < Buffer.byteLength(baseline) * 0.2)
    assert.equal(result.operationId, 'op'); assert.equal(result.changeSummary.total, count)
    assert.equal(result.changeSummary.states.NOT_APPLIED, 1); assert.equal(result.changes[0].reason, 'declined')
    assert.equal(result.value.printed, undefined); assert.equal(result.proposals, undefined)
    assert.equal(JSON.stringify(raw), unchanged)
    console.log(JSON.stringify({ fixture: `changes-${count}`, baselineBytes: Buffer.byteLength(baseline), currentBytes: Buffer.byteLength(current), providerCalls: 0 }))
  }
})

test('oversized values, Unicode logs and replay retain status and explicit evidence access', () => {
  const raw = { ok: false, operationId: 'op', generation: 'g', message: '検証に失敗', value: { printed: 'duplicates', json: { state: 'FAILED', stdout: '🙂日本語'.repeat(20000) }, ref: 'g/2' }, output: { stdout: '証拠'.repeat(40000) }, changes: [] }
  for (const input of [raw, { replay: true, operationId: 'op', state: 'SUCCEEDED', result: raw }]) {
    const text = renderResult(input), result = JSON.parse(text)
    assert.ok(Buffer.byteLength(text) <= RESULT_BYTES)
    assert.equal(result.ok, false); assert.equal(result.operationId, 'op'); assert.equal(result.message, raw.message)
    assert.equal(result.inspect.resultOperationId, 'op'); assert.ok(result.truncated)
    assert.doesNotMatch(text, /\uFFFD/u)
  }
})

test('job status is lossless JSON for running, finished and failed jobs', () => {
  const worker = new LispWorker({} as any, LispConfig.parse({}))
  for (const job of [{}, { result: { code: 0 } }, { error: 'JOB_TIMEOUT' }]) {
    worker.jobs.clear(); worker.jobs.set('job', job as any)
    assert.deepEqual(worker.jobStatus(), JSON.parse(JSON.stringify(worker.jobStatus())))
  }
})

test('saved evidence pages survive generation changes and cannot cross owner boundaries', async t => {
  const f = await fixture(t), text = '🙂証拠'.repeat(10000)
  await f.store.reserve(f.owner, 'op', 'lisp_eval', 'hash', 'old-generation', {})
  await f.store.transition(f.owner, 'op', ['RUNNING'], 'SUCCEEDED', { output: { stdout: text } })
  let offset = 0, collected = ''
  do {
    const page = await inspectSavedResult(f.store, f.owner, { resultOperationId: 'op', section: 'stdout', offset })
    assert.ok(Buffer.byteLength(renderResult(page)) <= RESULT_BYTES)
    collected += page.data; if (page.nextOffset === null) break; offset = page.nextOffset
  } while (true)
  assert.equal(collected, text)
  for (const owner of [{ ...f.owner, sessionId: 'other' }, { ...f.owner, agentId: 'other' }]) await assert.rejects(inspectSavedResult(f.store, owner, { resultOperationId: 'op' }), /操作記録がありません/u)
  assert.equal((await f.store.operations(f.owner.sessionId)).length, 1, 'inspection must not replay or add execution records')
  const manager = new LispManager({ store: f.store, config: LispConfig.parse({}), dataRoot: join(f.base, 'runtime') })
  manager.enabled.set(f.owner.sessionId, f.root)
  const result = await manager.execute(f.owner, 'lisp_inspect', { operationId: 'lookup', resultOperationId: 'op', section: 'stdout', limit: 5 }) as any
  assert.equal(result.data, Array.from(text).slice(0, 5).join(''))
})

test('the rendered inspection hint retrieves the omitted verifier log even when Lisp also prints', async t => {
  const f = await fixture(t), verifierOutput = 'compiler failure\n'.repeat(4000)
  const saved = { ok: true, operationId: 'verify', value: { json: { target: 'test', state: 'FAILED', code: 1, stdout: verifierOutput, stderr: '' }, ref: 'g/1' },
    output: { stdout: 'Launching verifier\n', stderr: '' }, changes: [] }
  await f.store.reserve(f.owner, 'verify', 'lisp_eval', 'hash', 'g', {})
  await f.store.transition(f.owner, 'verify', ['RUNNING'], 'SUCCEEDED', saved)
  const summary = JSON.parse(renderResult(saved))
  assert.ok(summary.inspect)
  const { tool: _tool, ...hint } = summary.inspect
  let offset = 0, actual = ''
  do {
    const page = await inspectSavedResult(f.store, f.owner, { ...hint, offset })
    actual += page.data
    if (page.nextOffset === null) break
    offset = page.nextOffset
  } while (true)
  assert.equal(digest(actual), digest(verifierOutput), 'following the model-visible hint must return the exact omitted evidence')
})

test('inspection hints escape stored keys and cannot follow inherited properties', async t => {
  const f = await fixture(t), source = 'evidence'.repeat(3000)
  const saved = { ok: true, operationId: 'keys', value: { json: { 'a/b~c': source } }, changes: [] }
  await f.store.reserve(f.owner, 'keys', 'lisp_eval', 'hash', 'g', {})
  await f.store.transition(f.owner, 'keys', ['RUNNING'], 'SUCCEEDED', saved)
  const { tool: _tool, ...hint } = JSON.parse(renderResult(saved)).inspect
  assert.equal(hint.pointer, '/value/json/a~1b~0c')
  assert.equal((await inspectSavedResult(f.store, f.owner, hint)).data, source.slice(0, 2000))
  for (const pointer of ['/toString', '/value/json/__proto__']) await assert.rejects(inspectSavedResult(f.store, f.owner, { resultOperationId: 'keys', pointer }), { code: 'UNKNOWN_RESULT_FIELD' })
  await assert.rejects(inspectSavedResult(f.store, f.owner, { resultOperationId: 'keys', pointer: '/value/~wrong' }), { code: 'INVALID_POINTER' })
})

test('serialized page size adjusts nextOffset before model rendering, without skipped characters', async t => {
  const f = await fixture(t), key = '項'.repeat(990), id = '記'.repeat(256), source = '\u0000'.repeat(3000)
  await f.store.reserve(f.owner, id, 'lisp_eval', 'hash', 'g', {})
  await f.store.transition(f.owner, id, ['RUNNING'], 'SUCCEEDED', { value: { json: { [key]: source } } })
  let offset = 0, actual = '', pages = 0
  do {
    const page = await inspectSavedResult(f.store, f.owner, { resultOperationId: id, pointer: `/value/json/${key}`, offset })
    const serialized = renderResult(page), visible = JSON.parse(serialized)
    assert.ok(Buffer.byteLength(serialized) <= RESULT_BYTES); assert.equal(typeof visible.data, 'string')
    actual += visible.data; pages++
    if (visible.nextOffset === null) break
    assert.equal(visible.nextOffset, offset + Array.from(visible.data).length)
    offset = visible.nextOffset
  } while (pages < 10)
  assert.equal(actual.length, source.length); assert.ok(pages > 1)
})

test('startup quarantines incomplete legacy success without guessing an unlinked write did not happen', async t => {
  const f = await fixture(t)
  const raw = { ok: true, operationId: 'legacy', proposals: [{ operation: 'write', path: 'a.txt', content: 'written' }] }
  for (const id of ['legacy', 'complete']) {
    await f.store.reserve(f.owner, id, 'lisp_eval', id, 'old-generation', { policyVersion: 1 })
    await f.store.transition(f.owner, id, ['RUNNING'], 'SUCCEEDED', { ...raw, operationId: id,
      ...(id === 'complete' ? { changes: [{ id: 'p', path: 'a.txt', state: 'APPLIED' }] } : {}) })
  }
  await writeFile(join(f.root, 'a.txt'), 'written')
  await f.store.start()
  assert.equal((await f.store.get(f.owner, 'legacy'))!.state, 'UNKNOWN')
  assert.equal((await f.store.get(f.owner, 'complete'))!.state, 'SUCCEEDED')
  const result = await inspectSavedResult(f.store, f.owner, { resultOperationId: 'legacy', section: 'changes' })
  const changes = JSON.parse(result.data)
  assert.equal(changes[0].state, 'UNKNOWN'); assert.equal(changes[0].reason, 'legacy_receipt_unavailable')
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'written')
})

test('batch approval applies once, skips unchanged files and supports shared new parents', async t => {
  const f = await fixture(t); let asks = 0
  await writeFile(join(f.root, 'old.txt'), 'old'); await writeFile(join(f.root, 'same.txt'), 'same')
  const batch = new LispProposalBatch({ store: f.store, backupRoot: join(f.base, 'backups'), protectedRoots: () => [], stopped: () => false,
    questions: { ask: async request => { asks++; assert.match(request.questions[0].detail!, /-old\n\+new/); return allowed.ask(request) } } })
  const changes = await batch.apply(f.owner, 'eval', 'g', [
    { operation: 'write', path: 'old.txt', content: 'new' }, { operation: 'write', path: 'same.txt', content: 'same' },
    { operation: 'write', path: 'new/dir/a.txt', content: 'a' }, { operation: 'write', path: 'new/dir/b.txt', content: 'b' },
  ], new AbortController().signal)
  assert.equal(asks, 1); assert.equal(changes.filter(c => c.state === 'APPLIED').length, 3)
  assert.equal(changes.find(c => c.path === 'same.txt')?.state, 'UNCHANGED')
  assert.equal(await readFile(join(f.root, 'new/dir/b.txt'), 'utf8'), 'b')
  assert.equal(await readFile(changes.find(c => c.path === 'old.txt')!.backup!, 'utf8'), 'old')
})

test('duplicate targets, refusal and approval-time changes produce no writes', async t => {
  for (const scenario of ['duplicate', 'deny', 'mutate'] as const) {
    const f = await fixture(t); let asks = 0
    await writeFile(join(f.root, 'a.txt'), 'old'); await writeFile(join(f.root, 'b.txt'), 'old')
    const batch = new LispProposalBatch({ store: f.store, backupRoot: join(f.base, 'backups'), protectedRoots: () => [], stopped: () => false,
      questions: { ask: async request => {
        asks++; if (scenario === 'mutate') await writeFile(join(f.root, 'b.txt'), 'external')
        return scenario === 'deny' ? { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options![0]!.label] }] } : allowed.ask(request)
      } } })
    const changes = await batch.apply(f.owner, 'eval', 'g', ['a.txt', scenario === 'duplicate' ? 'a.txt' : 'b.txt'].map(path => ({ operation: 'write', path, content: 'new' })), new AbortController().signal)
    assert.ok(changes.every(c => c.state === 'NOT_APPLIED')); assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'old')
    assert.equal(asks, scenario === 'duplicate' ? 0 : 1)
    if (scenario === 'deny') assert.ok(changes.every(c => c.reason === 'declined'))
  }
})

test('failure after a write retains APPLIED, UNKNOWN and unattempted outcomes', async t => {
  const f = await fixture(t)
  const original = f.store.transition.bind(f.store); let applied = 0
  f.store.transition = async (...args) => { if (args[3] === 'APPLIED' && ++applied === 2) throw new Error('commit failed'); return original(...args) }
  const batch = new LispProposalBatch({ store: f.store, backupRoot: join(f.base, 'backups'), protectedRoots: () => [], stopped: () => false })
  const changes = await batch.apply(f.owner, 'eval', 'g', ['a', 'b', 'c'].map(path => ({ operation: 'write', path, content: 'new' })), new AbortController().signal)
  assert.deepEqual(changes.map(c => c.state), ['APPLIED', 'UNKNOWN', 'NOT_APPLIED'])
  await assert.rejects(readFile(join(f.root, 'c')), { code: 'ENOENT' })
  assert.equal((await f.store.pendingTargets()).length, 1)
})

test('approval distinguishes timeout, cancellation, unavailable UI and invalid answers', async () => {
  const q = { id: 'review', question: 'apply?', options: [{ label: 'no' }, { label: 'yes' }], intent: { kind: 'plan-review' as const, approve: 'yes' } }
  assert.deepEqual(await confirm(undefined, 'a', q, new AbortController().signal), { approved: false, reason: 'unavailable' })
  assert.deepEqual(await confirm(allowed, 'a', q, AbortSignal.abort()), { approved: false, reason: 'cancelled' })
  assert.deepEqual(await confirm({ ask: () => new Promise(() => {}) }, 'a', q, new AbortController().signal, 5), { approved: false, reason: 'timed_out' })
  assert.deepEqual(await confirm({ ask: async () => ({ answers: [{ id: 'wrong', selected: ['yes'] }] }) }, 'a', q, new AbortController().signal), { approved: false, reason: 'invalid_answer' })
})

test('cancellation between writes preserves completed work and stops the remaining batch', async t => {
  const f = await fixture(t), controller = new AbortController()
  const transition = f.store.transition.bind(f.store)
  f.store.transition = async (...args) => { await transition(...args); if (args[3] === 'APPLIED') controller.abort() }
  const batch = new LispProposalBatch({ store: f.store, backupRoot: join(f.base, 'backups'), protectedRoots: () => [], stopped: () => false })
  const result = await batch.apply(f.owner, 'eval', 'g', ['a', 'b'].map(path => ({ operation: 'write', path, content: 'new' })), controller.signal)
  assert.deepEqual(result.map(c => c.state), ['APPLIED', 'NOT_APPLIED']); assert.equal(result[1]!.reason, 'cancelled')
  assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'new'); await assert.rejects(readFile(join(f.root, 'b')), { code: 'ENOENT' })
})

test('model status pagination never skips omitted records or truncates their identifiers', () => {
  const operations = Array.from({ length: 10 }, (_, i) => ({ id: `op-${i}`, agent: '識別'.repeat(200), kind: 'lisp_eval', state: 'SUCCEEDED', updatedAt: '2026-01-01' }))
  const result = JSON.parse(renderResult({ state: 'READY', operations, offset: 0, nextOffset: 10, operationCount: 20, pendingCount: 0,
    jobs: Array.from({ length: 100 }, () => ({ error: 'err'.repeat(3000) })) }))
  assert.ok(result.operations.length > 0); assert.equal(result.nextOffset, result.operations.length)
  assert.equal(result.operations[0].agent, operations[0]!.agent)
})

test('approval is bound to copied proposal content and changing scripts invalidates verifier consent', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'a'), 'old')
  const request = { operation: 'write' as const, path: 'a', content: 'approved' }
  const batch = new LispProposalBatch({ store: f.store, backupRoot: join(f.base, 'backups'), protectedRoots: () => [], stopped: () => false,
    questions: { ask: async q => { request.content = 'unapproved'; return allowed.ask(q) } } })
  assert.equal((await batch.apply(f.owner, 'eval', 'g', [request], new AbortController().signal))[0]!.state, 'APPLIED')
  assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'approved')
  const path = join(f.root, 'package.json'); await writeFile(path, JSON.stringify({ scripts: { test: 'old' } })); let runs = 0
  const adapter = createLispCiAdapter({ ask: async q => { await writeFile(path, JSON.stringify({ scripts: { test: 'changed' } })); return allowed.ask(q) } }, async () => { runs++; return { code: 0, stdout: '', stderr: '' } })
  assert.equal((await adapter(f.owner, { kind: 'verify', target: 'test' }, new AbortController().signal) as any).code, 'TARGET_CHANGED')
  assert.equal(runs, 0)
})

test('verifier discovery, check fallback, focused scripts and missing scripts avoid speculative runs', async t => {
  const f = await fixture(t); let asks = 0; const runs: string[][] = []
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc', 'test:unit': 'node --test', test: 'npm run check' } }))
  const adapter = createLispCiAdapter({ ask: async request => { asks++; return allowed.ask(request) } }, async (_file, args) => { runs.push(args); return { code: 0, stdout: 'ok', stderr: '' } })
  assert.equal((await describeVerifiers(f.owner) as any).typecheck.script, 'check')
  for (const request of [{ target: 'build' as const }, { target: 'test' as const, script: 'test:missing' }, { target: 'test' as const, script: '--help' }]) {
    assert.equal((await adapter(f.owner, { kind: 'verify', ...request }, new AbortController().signal) as any).state, 'NOT_APPLIED')
  }
  assert.equal(asks, 0); assert.equal(runs.length, 0)
  await adapter(f.owner, { kind: 'verify', target: 'typecheck' }, new AbortController().signal)
  await adapter(f.owner, { kind: 'verify', target: 'test', script: 'test:unit' }, new AbortController().signal)
  assert.deepEqual(runs, [['run', 'check'], ['run', 'test:unit']]); assert.equal(asks, 2)
})
