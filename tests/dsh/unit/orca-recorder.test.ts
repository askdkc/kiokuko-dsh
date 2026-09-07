import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, access, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { TraceReader, TraceWriter } from '@orcareplay/core'
import { Config, OrcaConfig } from '../../../src/dsh/config.js'
import { projectOrcaJson } from '../../../src/dsh/orca-security.js'
import { orcaFixture, chunks, collect, request, response } from '../helpers/orca-fixture.js'

test('Orca config is opt-in, defaulted, and rejects invalid finite limits', () => {
  assert.equal(Config.parse({}).orca.enabled, false)
  assert.equal(Config.parse({ orca: {} }).orca.capture.reasoning, false)
  for (const value of [0, -1, Infinity, NaN, 1.2]) assert.equal(OrcaConfig.safeParse({ maxOpenTraces: value }).success, false)
  assert.equal(OrcaConfig.safeParse({ storage: 'cwd' }).success, false)
})
test('disabled recording makes no trace files and does not create a writer', async () => {
  let creates = 0
  const f = await orcaFixture({ enabled: false }, { createWriter: async () => { creates++; throw new Error('must not load') } })
  try {
    const input = response()
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(input))), input)
    await f.recorder.shutdown()
    assert.equal(creates, 0)
    await assert.rejects(access(join(f.root, '.orca')))
    assert.equal((await f.reader.list(f.binding)).length, 0)
  } finally { await f.dispose() }
})
test('concurrent model calls share a writer, retain identity and causal seqs, preserve cached usage', async () => {
  let creates = 0, nextCalls = 0
  const f = await orcaFixture({}, { loadCoreVersion: async () => '0.2.99', createWriter: async (...args) => { creates++; assert.deepEqual(args[1].envAllowlist, []); return TraceWriter.create(...args) } })
  try {
    const values = Object.freeze(response().map(c => Object.freeze(c)))
    const options = Object.freeze(request)
    const run = () => collect(f.recorder.stream(f.binding, options, () => { nextCalls++; return chunks([...values]) }))
    const [one, two] = await Promise.all([run(), run()])
    assert.equal(nextCalls, 2)
    one.forEach((v, i) => assert.equal(v, values[i])); two.forEach((v, i) => assert.equal(v, values[i]))
    const close1 = f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    assert.equal(close1, f.recorder.closeSessionRecording(f.binding.sessionId, 'manual'))
    await close1
    assert.equal(creates, 1)
    const rows = await f.reader.list(f.binding)
    assert.equal(rows[0]?.state, 'completed', JSON.stringify(rows))
    const row = rows[0]!
    const page = await f.reader.show(f.binding, row.orca_run_id)
    for (const event of page.events.filter(e => e.type === 'model.response')) {
      const cause = page.events.find(e => e.seq === event.causes?.[0])!
      assert.equal(cause.type, 'model.request')
      assert.equal(cause.attrs?.modelCallId, event.attrs?.modelCallId)
      assert.equal(event.attrs?.input_tokens, 12)
    }
    const manifest = JSON.parse(await readFile(join(f.root, '.orca/runs', row.orca_run_id, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.env_allowlisted, {})
    assert.equal(manifest.orca_version, '0.2.99')
    assert.equal(manifest.exit_code, undefined)
    const nativeReader = await TraceReader.open(join(f.root, '.orca/runs', row.orca_run_id))
    assert.equal((await nativeReader.events()).length, row.event_count)
    assert.ok((await f.reader.export(f.binding, row.orca_run_id)).endsWith('.html'))
  } finally { await f.dispose() }
})
test('unknown sessions and auxiliary calls are excluded without guessing', async () => {
  const f = await orcaFixture()
  try {
    await collect(f.recorder.stream(undefined, request, () => chunks(response())))
    await collect(f.recorder.stream(f.binding, { ...request, purpose: 'compaction' }, () => chunks(response())))
    assert.equal((await f.reader.list(f.binding)).length, 0)
    assert.equal(f.recorder.diagnostics.unattributed, 1)
    assert.equal(f.recorder.diagnostics.auxiliary, 1)
  } finally { await f.dispose() }
})
for (const mode of ['throw', 'return', 'missing-finish', 'aborted'] as const) test(`stream ${mode} preserves upstream semantics`, async () => {
  const f = await orcaFixture()
  const original = new Error('upstream secret not to persist')
  let finalized = false
  try {
    async function* upstream() {
      try { yield response()[0]; if (mode === 'throw') throw original; if (mode === 'aborted') yield { type: 'finish', reason: { kind: 'aborted' } } }
      finally { finalized = true }
    }
    const stream = f.recorder.stream(f.binding, request, upstream)
    if (mode === 'throw') await assert.rejects(collect(stream), error => error === original)
    else if (mode === 'return') { for await (const _chunk of stream) break }
    else await collect(stream)
    assert.equal(finalized, true)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, mode === 'throw' || mode === 'aborted' ? 'completed' : 'incomplete', JSON.stringify(row))
  } finally { await f.dispose() }
})
test('pre-execute survives permission wait and shutdown until the final rejected result', async () => {
  const f = await orcaFixture({ shutdownDrainTimeoutMs: 1000 })
  try {
    const exec = { token: Symbol(), callId: 'one', rootCallId: 'one', name: 'tool', arguments: { hello: 'world' } }
    f.recorder.preTool(f.binding, exec)
    const closing = f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    f.recorder.toolDecision(exec, { kind: 'allow' })
    f.recorder.toolDispatch(exec)
    f.recorder.toolDispatched(exec)
    f.recorder.toolResult(f.binding, exec, { isError: true, content: [{ type: 'text', text: 'post-policy denied' }] })
    await closing
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed')
    const events = (await f.reader.show(f.binding, row.orca_run_id)).events
    assert.equal(events.filter(e => e.type === 'tool.call').length, 1)
    const result = events.find(e => e.type === 'tool.result')!
    assert.equal(result.attrs?.is_error, true)
    assert.equal(events.find(e => e.seq === result.causes?.[0])?.type, 'tool.call')
  } finally { await f.dispose() }
})
test('permission timeout is incomplete and late result never reopens the old generation', async () => {
  const f = await orcaFixture()
  try {
    const exec = { token: Symbol(), callId: 'one', rootCallId: 'one', name: 'tool', arguments: {} }
    f.recorder.preTool(f.binding, exec)
    await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    const old = (await f.reader.list(f.binding))[0]!
    assert.equal(old.state, 'incomplete'); assert.equal(old.unresolved_call_count, 1)
    f.recorder.start(f.binding)
    f.recorder.toolResult(f.binding, exec, { isError: false, content: [] })
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 2)
    assert.equal(f.recorder.diagnostics.lateResults, 1)
    assert.notEqual(rows[0]?.orca_run_id, rows[1]?.orca_run_id)
  } finally { await f.dispose() }
})
for (const content of ['redacted', 'metadata'] as const) test(`projection ${content} omits secrets, reasoning, attachments and replayState`, async () => {
  const f = await orcaFixture({ capture: { content } })
  try {
    const text = 'sk-testsecret123456789 Authorization: Bearer DUMMYVALUE\n<script>alert("x")</script>'
    const values = [...response(text), { type: 'reasoning-delta', index: 9, text: 'PRIVATE_REASONING' },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { secret: 'PRIVATE_REPLAY' } }]
    await collect(f.recorder.stream(f.binding, { ...request, signal: new AbortController().signal }, () => chunks(values)))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify(row))
    const htmlPath = await f.reader.export(f.binding, row.orca_run_id)
    const html = await readFile(htmlPath, 'utf8')
    for (const secret of ['sk-testsecret123456789','DUMMYVALUE','PRIVATE_REASONING','PRIVATE_REPLAY']) assert.ok(!html.includes(secret), secret)
    assert.ok(!html.includes('<script>alert("x")</script>'))
    if (content === 'metadata') assert.ok(!html.includes('alert('))
  } finally { await f.dispose() }
})
test('oversized event and cyclic/accessor values cannot bypass the projection budget', async () => {
  assert.throws(() => projectOrcaJson({ text: 'x'.repeat(1000) }, 100), /queue_limit/u)
  const cyclic: any = {}; cyclic.self = cyclic
  assert.throws(() => projectOrcaJson(cyclic, 10_000), /projection_cycle/u)
  assert.deepEqual(projectOrcaJson({ get secret() { throw new Error('must not invoke') } }, 1000), {})
  const f = await orcaFixture({ maxQueuedBytesPerTrace: 4096 })
  try {
    const input = response('x'.repeat(100_000))
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(input))), input)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.notEqual(row.state, 'completed'); assert.ok(row.missing_event_count > 0)
  } finally { await f.dispose() }
})
for (const failure of ['ENOSPC','EACCES','append','close'] as const) test(`writer ${failure} cannot change DSH results`, async () => {
  const f = await orcaFixture({}, { createWriter: async (...args) => {
    if (failure === 'ENOSPC' || failure === 'EACCES') throw Object.assign(new Error('private error'), { code: failure })
    const writer = await TraceWriter.create(...args)
    if (failure === 'append') writer.append = async () => { throw new Error('private append error') }
    else { const close = writer.close.bind(writer); writer.close = async () => { await close(); throw new Error('private close error') } }
    return writer
  } })
  try {
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(response()))), response())
    await f.recorder.shutdown()
    assert.notEqual((await f.reader.list(f.binding))[0]?.state, 'completed')
  } finally { await f.dispose() }
})
test('symlink storage is refused without touching its target', async () => {
  const f = await orcaFixture()
  try {
    await symlink(f.root, join(f.root, '.orca'))
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    assert.equal((await f.reader.list(f.binding))[0]?.state, 'failed')
    await assert.rejects(access(join(f.root, 'runs')))
  } finally { await f.dispose() }
})

for (const dependency of ['loadCore', 'loadSchema', 'loadCoreVersion'] as const) test(`missing ${dependency} is unavailable with no trace/index initialization`, async () => {
  const f = await orcaFixture({}, { [dependency]: async () => { throw new Error('missing module') } })
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    assert.equal(f.recorder.status(f.binding.sessionId).capability, 'unavailable')
    assert.equal((await f.reader.list(f.binding)).length, 0)
    await assert.rejects(access(join(f.root, '.orca')))
  } finally { await f.dispose() }
})
test('global queue and open trace ceilings apply during writer creation', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await orcaFixture({ maxQueuedBytesTotal: 1600, maxOpenTraces: 1 }, { createWriter: async (...args) => { await gate; return TraceWriter.create(...args) } })
  try {
    const values = response()
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(values))), values)
    assert.deepEqual(await collect(f.recorder.stream({ ...f.binding, sessionId: 'b' }, request, () => chunks(values))), values)
    release(); await f.recorder.shutdown()
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]?.state, 'completed')
  } finally { release(); await f.dispose() }
})
test('nested tools preserve parent identity and a result-only attempt has no invented start', async () => {
  const f = await orcaFixture()
  try {
    const parent = { token: Symbol(), callId: 'root', rootCallId: 'root', name: 'run_code', arguments: {} }
    const child = { token: Symbol(), parent: parent.token, callId: 'child', rootCallId: 'root', name: 'read', arguments: {} }
    f.recorder.preTool(f.binding, parent); f.recorder.preTool(f.binding, child)
    f.recorder.toolResult(f.binding, child, { isError: false, content: [] })
    f.recorder.toolResult(f.binding, parent, { isError: false, content: [] })
    f.recorder.toolResult(f.binding, { ...parent, token: Symbol(), callId: 'result-only' }, { isError: true, content: [] })
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const calls = (await f.reader.show(f.binding, row.orca_run_id)).events.filter(e => e.type === 'tool.call')
    assert.equal(calls.length, 3)
    assert.equal(calls[1]?.attrs?.parentAttemptId, calls[0]?.attrs?.attemptId)
    assert.equal(calls[2]?.attrs?.startObserved, false)
    assert.equal(calls[2]?.attrs?.dispatch_duration_ms, undefined)
  } finally { await f.dispose() }
})
test('index persistence failure is independent of native output and visible in status', async () => {
  const f = await orcaFixture()
  try {
    f.store.save = () => { throw new Error('private SQL failure') }
    const values = response()
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(values))), values)
    await f.recorder.shutdown()
    const status = f.recorder.status(f.binding.sessionId)
    assert.equal(status.persistenceFailed, true)
    assert.notEqual(status.trace?.state, 'completed')
    assert.ok(!JSON.stringify(status).includes('private SQL'))
  } finally { await f.dispose() }
})

test('recording store ignores itself in Git and separates an actual worktree', async () => {
  const f = await orcaFixture()
  const { execFileSync } = await import('node:child_process')
  const { detectRepositoryRoot } = await import('../../../src/repository/detect-root.js')
  try {
    execFileSync('git', ['init', '-q', f.root])
    execFileSync('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
    const worktree = join(f.root, 'worktree')
    execFileSync('git', ['-C', f.root, 'worktree', 'add', '--detach', worktree, 'HEAD'], { stdio: 'ignore' })
    const root = detectRepositoryRoot({ cwd: worktree }).root
    assert.notEqual(root, f.root)
    const other = { sessionId: 'worktree', workspaceRoot: root, sessionCwd: root, storeRoot: root }
    await Promise.all([f.binding, other].map(binding => collect(f.recorder.stream(binding, request, () => chunks(response())))))
    await f.recorder.shutdown()
    const a = (await f.reader.list(f.binding))[0]!, b = (await f.reader.list(other))[0]!
    assert.equal(a.state, 'completed'); assert.equal(b.state, 'completed')
    assert.notEqual(a.store_root, b.store_root)
    assert.match(execFileSync('git', ['-C', root, 'check-ignore', `.orca/runs/${b.orca_run_id}/manifest.json`], { encoding: 'utf8' }), /\.orca/u)
  } finally { await f.dispose() }
})
