import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, access, symlink, writeFile, mkdir, chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'
import { Config, AgenticReplayConfig } from '../../../src/dsh/config.js'
import { projectAgenticReplayJson } from '../../../src/dsh/agenticreplay-security.js'
import { agenticReplayFixture, chunks, collect, request, response } from '../helpers/agenticreplay-fixture.js'

const { TraceReader, TraceWriter } = await loadAgenticReplayLibrary('core')

test('oversized model requests keep bounded metadata and a correlated response', async () => {
  const f = await agenticReplayFixture({ maxQueuedBytesPerTrace: 16_384 })
  try {
    const huge = { ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100_000) }] }] }
    assert.deepEqual(await collect(f.recorder.stream(f.binding, huge, () => chunks(response()))), response())
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify(row))
    const events = await (await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))).events()
    const modelRequest = events.find(event => event.type === 'model.request')!
    const modelResponse = events.find(event => event.type === 'model.response')!
    assert.equal(modelRequest.attrs?.content_omitted, true)
    assert.equal((modelRequest.payload as any).omission_reason, 'payload_limit')
    assert.equal(events.find(event => event.seq === modelResponse.causes?.[0])?.seq, modelRequest.seq)
    assert.equal(events.filter(event => event.type === 'note' && event.attrs?.diagnostic === 'content_omitted').length, 1)
    assert.ok(!JSON.stringify(events).includes('x'.repeat(1024)))
  } finally { await f.dispose() }
})

test('native failure and memory finish failure stay observable without private exception text', async () => {
  const f = await agenticReplayFixture()
  try {
    const values = response().map((value: any) => value.type === 'finish' ? { ...value,
      reason: { kind: 'error', failure: { code: 'DSH_MEMORY_REBUILD_EXHAUSTED', message: 'PRIVATE-EXCEPTION-TEXT' } } } : value)
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(values))), values)
    f.recorder.nativeFailure(f.binding)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = (await f.reader.show(f.binding, row.agenticreplay_run_id)).events
    assert.ok(events.some(event => event.type === 'error' && event.attrs?.code === 'DSH_MEMORY_REBUILD_EXHAUSTED'))
    assert.ok(events.some(event => event.type === 'error' && event.attrs?.code === 'native_turn_failed'))
    assert.ok(events.some(event => event.type === 'model.response' && event.attrs?.failure_code === 'DSH_MEMORY_REBUILD_EXHAUSTED'))
    assert.equal(JSON.stringify(events).includes('PRIVATE-EXCEPTION-TEXT'), false)
  } finally { await f.dispose() }
})

for (const initial of [undefined, '# keep\nnode_modules/', '# keep\r\nnode_modules/\r\n', '.agenticreplay\nnode_modules/\n', '.agenticreplay/\n!.agenticreplay/\n']) {
  test(`recording protects the storage root before writer creation and preserves ignore content: ${JSON.stringify(initial)}`, async () => {
    let creates = 0
    const f = await agenticReplayFixture({}, { createWriter: async (...args) => {
      creates++
      const ignore = await readFile(join(f.root, '.gitignore'), 'utf8')
      if (initial !== undefined) assert.ok(ignore.startsWith(initial))
      execFileSync('git', ['-C', f.root, 'check-ignore', '.agenticreplay/exports/fixture.html'], { stdio: 'ignore' })
      return TraceWriter.create(...args)
    } })
    try {
      execFileSync('git', ['init', '-q', f.root])
      if (initial !== undefined) await writeFile(join(f.root, '.gitignore'), initial)
      await Promise.all([f.binding, { ...f.binding, sessionId: 'parallel' }].map(binding => collect(f.recorder.stream(binding, request, () => chunks(response())))))
      await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
      const once = await readFile(join(f.root, '.gitignore'), 'utf8')
      assert.equal(once.split(/\r?\n/u).filter(line => ['.agenticreplay', '.agenticreplay/'].includes(line)).length, initial?.includes('!.agenticreplay/') ? 2 : 1)
      f.recorder.start(f.binding)
      await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
      await f.recorder.shutdown()
      assert.equal(creates, 3)
      assert.equal(await readFile(join(f.root, '.gitignore'), 'utf8'), once)
      assert.equal(execFileSync('git', ['-C', f.root, 'ls-files', '--others', '--exclude-standard', '.agenticreplay'], { encoding: 'utf8' }), '')
    } finally { await f.dispose() }
  })
}

for (const unsafe of ['symlink', 'directory'] as const) test(`unsafe root gitignore ${unsafe} prevents capture without changing native output`, async () => {
  let creates = 0
  const f = await agenticReplayFixture({}, { createWriter: async () => { creates++; throw new Error('must not create') } })
  try {
    const target = join(f.root, 'user-owned')
    await writeFile(target, 'preserve me')
    if (unsafe === 'symlink') await symlink(target, join(f.root, '.gitignore'))
    else await mkdir(join(f.root, '.gitignore'))
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(response()))), response())
    await f.recorder.shutdown()
    assert.equal(creates, 0)
    assert.equal(f.recorder.status(f.binding.sessionId).trace?.last_error_code, 'gitignore_protection_failed')
    assert.equal(await readFile(target, 'utf8'), 'preserve me')
    await assert.rejects(access(join(f.root, '.agenticreplay/runs')))
  } finally { await f.dispose() }
})

test('an already protected read-only gitignore permits recording without a write', async () => {
  const f = await agenticReplayFixture()
  try {
    await writeFile(join(f.root, '.gitignore'), '.agenticreplay/\n')
    await chmod(join(f.root, '.gitignore'), 0o444)
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    assert.equal(f.recorder.status(f.binding.sessionId).trace?.state, 'completed')
    assert.equal(await readFile(join(f.root, '.gitignore'), 'utf8'), '.agenticreplay/\n')
  } finally { await f.dispose() }
})

test('new recordings use the AgenticReplay manifest contract and storage namespace', async () => {
  const f = await agenticReplayFixture()
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed')
    const manifest = JSON.parse(await readFile(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id, 'manifest.json'), 'utf8'))
    assert.equal(typeof manifest.agenticreplay_version, 'string')
    assert.equal(manifest.orca_version, undefined)
    await access(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id, 'manifest.json'))
    await assert.rejects(access(join(f.root, '.orca')))
  } finally { await f.dispose() }
})

test('AgenticReplay config records by default, allows explicit opt-out, and rejects invalid finite limits', () => {
  assert.equal(Config.safeParse({ orca: { enabled: false } }).success, false)
  assert.equal(Config.parse({}).agenticReplay.enabled, true)
  assert.equal(Config.parse({ agenticReplay: {} }).agenticReplay.enabled, true)
  assert.equal(Config.parse({ agenticReplay: { enabled: false } }).agenticReplay.enabled, false)
  assert.equal(Config.parse({ agenticReplay: {} }).agenticReplay.capture.reasoning, false)
  assert.equal(Config.parse({ agenticReplay: {} }).agenticReplay.askOnStart, false)
  assert.equal(Config.parse({ agenticReplay: { askOnStart: true } }).agenticReplay.askOnStart, true)
  for (const value of [0, -1, Infinity, NaN, 1.2]) assert.equal(AgenticReplayConfig.safeParse({ maxOpenTraces: value }).success, false)
  assert.equal(AgenticReplayConfig.safeParse({ storage: 'cwd' }).success, false)
})
test('disabled recording makes no trace files and does not create a writer', async () => {
  let creates = 0
  const f = await agenticReplayFixture({ enabled: false }, { createWriter: async () => { creates++; throw new Error('must not load') } })
  try {
    const input = response()
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(input))), input)
    await f.recorder.shutdown()
    assert.equal(creates, 0)
    await assert.rejects(access(join(f.root, '.agenticreplay')))
    await assert.rejects(access(join(f.root, '.gitignore')))
    assert.equal((await f.reader.list(f.binding)).length, 0)
  } finally { await f.dispose() }
})
test('concurrent model calls share a writer, retain identity and causal seqs, preserve cached usage', async () => {
  let creates = 0, nextCalls = 0
  const f = await agenticReplayFixture({}, { loadCoreVersion: async () => '0.2.99', createWriter: async (...args) => { creates++; assert.deepEqual(args[1].envAllowlist, []); return TraceWriter.create(...args) } })
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
    const page = await f.reader.show(f.binding, row.agenticreplay_run_id)
    for (const event of page.events.filter(e => e.type === 'model.response')) {
      const cause = page.events.find(e => e.seq === event.causes?.[0])!
      assert.equal(cause.type, 'model.request')
      assert.equal(cause.attrs?.modelCallId, event.attrs?.modelCallId)
      assert.equal(event.attrs?.input_tokens, 12)
    }
    const manifest = JSON.parse(await readFile(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.env_allowlisted, {})
    assert.equal(manifest.agenticreplay_version, '0.2.99')
    assert.equal(manifest.exit_code, undefined)
    const nativeReader = await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))
    assert.equal((await nativeReader.events()).length, row.event_count)
    assert.ok((await f.reader.export(f.binding, row.agenticreplay_run_id)).endsWith('.html'))
  } finally { await f.dispose() }
})

test('the recorded final model request carries bounded provenance for the host section it received', async () => {
  const f = await agenticReplayFixture({ capture: { content: 'metadata' } })
  try {
    const text = 'The current runtime contract'
    const options = { ...request, messages: [{ role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [{ name: 'route-skill:kiokuko-soul', text }] } }] }
    await collect(f.recorder.stream(f.binding, options, () => chunks(response())))
    await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
    const row = (await f.reader.list(f.binding))[0]!
    const page = await f.reader.show(f.binding, row.agenticreplay_run_id)
    const model = page.events.find(event => event.type === 'model.request')!
    const payload = model.payload as any
    assert.equal(payload.sources.items[0].id, 'route-skill:kiokuko-soul')
    assert.equal(payload.sources.coverage, 'observed')
    assert.doesNotMatch(JSON.stringify(payload), /The current runtime contract/)
  } finally { await f.dispose() }
})
test('unknown sessions and auxiliary calls are excluded without guessing', async () => {
  const f = await agenticReplayFixture()
  try {
    await collect(f.recorder.stream(undefined, request, () => chunks(response())))
    await collect(f.recorder.stream(f.binding, { ...request, purpose: 'compaction' }, () => chunks(response())))
    assert.equal((await f.reader.list(f.binding)).length, 0)
    assert.equal(f.recorder.diagnostics.unattributed, 1)
    assert.equal(f.recorder.diagnostics.auxiliary, 1)
  } finally { await f.dispose() }
})
for (const mode of ['throw', 'return', 'missing-finish', 'aborted'] as const) test(`stream ${mode} preserves upstream semantics`, async () => {
  const f = await agenticReplayFixture()
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
  const f = await agenticReplayFixture({ shutdownDrainTimeoutMs: 1000 })
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
    const events = await (await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))).events()
    assert.equal(events.filter(e => e.type === 'tool.call').length, 1)
    const result = events.find(e => e.type === 'tool.result')!
    assert.equal(result.attrs?.is_error, true)
    assert.equal(events.find(e => e.seq === result.causes?.[0])?.type, 'tool.call')
  } finally { await f.dispose() }
})
test('permission timeout is incomplete and late result never reopens the old generation', async () => {
  const f = await agenticReplayFixture()
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
    assert.notEqual(rows[0]?.agenticreplay_run_id, rows[1]?.agenticreplay_run_id)
  } finally { await f.dispose() }
})
for (const content of ['redacted', 'metadata'] as const) test(`projection ${content} omits secrets, reasoning, attachments and replayState`, async () => {
  const f = await agenticReplayFixture({ capture: { content } })
  try {
    const text = 'sk-testsecret123456789 Authorization: Bearer DUMMYVALUE\n<script>alert("x")</script>'
    const values = [...response(text), { type: 'reasoning-delta', index: 9, text: 'PRIVATE_REASONING' },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { secret: 'PRIVATE_REPLAY' } }]
    await collect(f.recorder.stream(f.binding, { ...request, signal: new AbortController().signal }, () => chunks(values)))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify(row))
    const htmlPath = await f.reader.export(f.binding, row.agenticreplay_run_id)
    const html = await readFile(htmlPath, 'utf8')
    for (const secret of ['sk-testsecret123456789','DUMMYVALUE','PRIVATE_REASONING','PRIVATE_REPLAY']) assert.ok(!html.includes(secret), secret)
    assert.ok(!html.includes('<script>alert("x")</script>'))
    if (content === 'metadata') assert.ok(!html.includes('alert('))
  } finally { await f.dispose() }
})
test('oversized event and cyclic/accessor values cannot bypass the projection budget', async () => {
  assert.throws(() => projectAgenticReplayJson({ text: 'x'.repeat(1000) }, 100), /queue_limit/u)
  const cyclic: any = {}; cyclic.self = cyclic
  assert.throws(() => projectAgenticReplayJson(cyclic, 10_000), /projection_cycle/u)
  assert.deepEqual(projectAgenticReplayJson({ get secret() { throw new Error('must not invoke') } }, 1000), {})
  const f = await agenticReplayFixture({ maxQueuedBytesPerTrace: 4096 })
  try {
    const input = response('x'.repeat(100_000))
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(input))), input)
    // Separate payload omission from a subsequent burst exceeding the queue.
    // Only the test drains capture; native completion never waits for it.
    await f.recorder.flushDiagnostics(f.binding.sessionId)
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(response('later event')))), response('later event'))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = await (await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))).events()
    assert.equal(row.state, 'completed', JSON.stringify({ row, diagnostics: f.recorder.status(f.binding.sessionId).diagnostics,
      events: events.map(({ type, attrs, causes }) => ({ type, attrs, causes })) })); assert.equal(row.missing_event_count, 0)
    const responses = events.filter(e => e.type === 'model.response')
    assert.equal(responses.length, 2)
    assert.equal(responses[0]!.attrs?.content_omitted, true)
    assert.equal((responses[0]!.payload as any).omission_reason, 'payload_limit')
    assert.equal(events.find(e => e.seq === responses[0]!.causes?.[0])?.type, 'model.request')
    assert.match(JSON.stringify(events.find(e => e.type === 'note')?.attrs), /content_omitted/u)
    assert.ok(!JSON.stringify(events).includes('x'.repeat(1024)))
    assert.equal(f.recorder.status(f.binding.sessionId).diagnostics.omittedBodies, 1)
  } finally { await f.dispose() }
})
test('oversized tool call and result bodies retain correlated metadata and diagnostics', async () => {
  const f = await agenticReplayFixture({ maxQueuedBytesPerTrace: 4096 })
  try {
    const exec = { token: Symbol(), callId: 'large-tool', rootCallId: 'large-tool', name: 'large_tool', arguments: { value: 'a'.repeat(20_000) } }
    f.recorder.preTool(f.binding, exec)
    f.recorder.toolResult(f.binding, exec, { isError: true, content: [{ type: 'text', text: 'b'.repeat(20_000) }] })
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = await (await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))).events()
    assert.equal(row.state, 'completed', JSON.stringify({ row, diagnostics: f.recorder.status(f.binding.sessionId).diagnostics,
      events: events.map(({ type, attrs, causes }) => ({ type, attrs, causes })) }))
    const call = events.find(e => e.type === 'tool.call')!, result = events.find(e => e.type === 'tool.result')!
    assert.equal(call.attrs?.content_omitted, true)
    assert.equal(result.attrs?.content_omitted, true)
    assert.equal(result.attrs?.is_error, true)
    assert.equal(events.find(e => e.seq === result.causes?.[0])?.seq, call.seq)
    assert.equal(events.filter(e => e.type === 'note' && e.attrs?.diagnostic === 'content_omitted').length, 2)
    assert.ok(!JSON.stringify(events).includes('a'.repeat(1024)))
    assert.ok(!JSON.stringify(events).includes('b'.repeat(1024)))
  } finally { await f.dispose() }
})
for (const failure of ['ENOSPC','EACCES','append','close'] as const) test(`writer ${failure} cannot change DSH results`, async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (...args) => {
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
  const f = await agenticReplayFixture()
  try {
    await symlink(f.root, join(f.root, '.agenticreplay'))
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    assert.equal((await f.reader.list(f.binding))[0]?.state, 'failed')
    await assert.rejects(access(join(f.root, 'runs')))
  } finally { await f.dispose() }
})

for (const dependency of ['loadCore', 'loadSchema', 'loadCoreVersion'] as const) test(`missing ${dependency} is unavailable with no trace/index initialization`, async () => {
  const f = await agenticReplayFixture({}, { [dependency]: async () => { throw new Error('missing module') } })
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    assert.equal(f.recorder.status(f.binding.sessionId).capability, 'unavailable')
    assert.equal((await f.reader.list(f.binding)).length, 0)
    await assert.rejects(access(join(f.root, '.agenticreplay')))
  } finally { await f.dispose() }
})
test('global queue and open trace ceilings apply during writer creation', { timeout: 5000 }, async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await agenticReplayFixture({ maxQueuedBytesTotal: 1600, maxOpenTraces: 1 }, { createWriter: async (...args) => { await gate; return TraceWriter.create(...args) } })
  try {
    const values = response()
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(values))), values)
    assert.deepEqual(await collect(f.recorder.stream({ ...f.binding, sessionId: 'b' }, request, () => chunks(values))), values)
    release(); await f.recorder.shutdown()
    const rows = await f.reader.list(f.binding)
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]?.state, 'completed')
    assert.equal(rows[0]?.last_error_code, 'queue_limit')
    const diagnostic = JSON.parse(await readFile(join(f.root, '.agenticreplay/runs', rows[0]!.agenticreplay_run_id, 'capture-status.json'), 'utf8'))
    assert.equal(diagnostic.lastErrorCode, 'queue_limit')
    assert.ok(diagnostic.missingEvents > 0)
  } finally { release(); await f.dispose() }
})
test('nested tools preserve parent identity and a result-only attempt has no invented start', async () => {
  const f = await agenticReplayFixture()
  try {
    const parent = { token: Symbol(), callId: 'root', rootCallId: 'root', name: 'run_code', arguments: {} }
    const child = { token: Symbol(), parent: parent.token, callId: 'child', rootCallId: 'root', name: 'read', arguments: {} }
    f.recorder.preTool(f.binding, parent); f.recorder.preTool(f.binding, child)
    f.recorder.toolResult(f.binding, child, { isError: false, content: [] })
    f.recorder.toolResult(f.binding, parent, { isError: false, content: [] })
    f.recorder.toolResult(f.binding, { ...parent, token: Symbol(), callId: 'result-only' }, { isError: true, content: [] })
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const calls = (await f.reader.show(f.binding, row.agenticreplay_run_id)).events.filter(e => e.type === 'tool.call')
    assert.equal(calls.length, 3)
    assert.equal(calls[1]?.attrs?.parentAttemptId, calls[0]?.attrs?.attemptId)
    assert.equal(calls[2]?.attrs?.startObserved, false)
    assert.equal(calls[2]?.attrs?.dispatch_duration_ms, undefined)
  } finally { await f.dispose() }
})
test('index persistence failure is independent of native output and visible in status', async () => {
  const f = await agenticReplayFixture()
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
  const f = await agenticReplayFixture()
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
    assert.match(execFileSync('git', ['-C', root, 'check-ignore', `.agenticreplay/runs/${b.agenticreplay_run_id}/manifest.json`], { encoding: 'utf8' }), /\.agenticreplay/u)
  } finally { await f.dispose() }
})


test('native structured errors and process failures remain failures despite a false flag; domain error data remains ordinary content', async () => {
  const f = await agenticReplayFixture()
  try {
    const cases = [
      { isError: false, error: { type: 'tool.execution', message: 'PRIVATE-ERROR-BODY' }, content: [] },
      { isError: false, error: { type: 'provider.transport', status: 200, message: 'PRIVATE-ERROR-BODY' }, content: [] },
      { isError: false, value: { exitCode: 1 }, content: [] },
      { isError: false, value: { timedOut: true }, content: [] },
      { isError: false, value: { error: { type: 'domain' } }, content: [{ type: 'text', text: '{"error":{"type":"example"}}' }] },
    ]
    for (const [index, result] of cases.entries()) {
      const exec = { token: Symbol(), callId: `outcome-${index}`, rootCallId: `outcome-${index}`, name: 'patch', arguments: {} }
      f.recorder.preTool(f.binding, exec)
      f.recorder.toolResult(f.binding, exec, result)
      assert.equal(result.isError, false, 'observation must not mutate native behavior')
    }
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = await (await TraceReader.open(join(f.root, '.agenticreplay/runs', row.agenticreplay_run_id))).events()
    const results = events.filter(event => event.type === 'tool.result')
    assert.deepEqual(results.map(event => event.attrs?.is_error), [true, true, true, true, false])
    assert.ok(results.every(event => event.attrs?.native_is_error === false))
    assert.ok(results.slice(0, 4).every(event => event.attrs?.error_flag_conflict === true))
    assert.equal(results[4]?.attrs?.error_flag_conflict, undefined)
    assert.equal(JSON.stringify(events).includes('PRIVATE-ERROR-BODY'), false)
  } finally { await f.dispose() }
})
