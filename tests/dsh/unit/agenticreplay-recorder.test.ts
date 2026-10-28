import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readFile, access, symlink, writeFile, mkdir, chmod, rename } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'
import { Config, AgenticReplayConfig } from '../../../src/dsh/config.js'
import { projectAgenticReplayJson } from '../../../src/dsh/agenticreplay-security.js'
import { recordedRunDirectory, agenticReplayFixture, chunks, collect, request, response } from '../helpers/agenticreplay-fixture.js'
import { secretCases, benignCases } from '../helpers/agenticreplay-redaction-cases.js'
import { captureRedactionCase } from '../helpers/agenticreplay-redaction.js'

const { TraceReader, TraceWriter } = await loadAgenticReplayLibrary('core')

for(const content of ['redacted','metadata'] as const)for(const [name,input,needle] of secretCases) test(`real writer credentials through all payloads and files: ${content}/${name}`,async()=>{
  const captured=await captureRedactionCase(input,content)
  captured.inspect(needle)
})
for(const input of benignCases)test(`real writer preserves benign body: ${input}`,async()=>{
  const captured=await captureRedactionCase(input,'redacted')
  assert.ok(captured.persisted.includes(input.replaceAll('"','\\"')) || captured.persisted.includes(input))
  assert.ok(captured.htmlText.includes(input.replaceAll('"','\\"')) || captured.htmlText.includes(input))
})
test('capture has no raw mode',()=>assert.equal(AgenticReplayConfig.safeParse({capture:{content:'raw'}}).success,false))

test('oversized model requests keep bounded metadata and a correlated response', async () => {
  const f = await agenticReplayFixture({ maxQueuedBytesPerTrace: 16_384 })
  try {
    const huge = { ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100_000) }] }] }
    assert.deepEqual(await collect(f.recorder.stream(f.binding, huge, () => chunks(response()))), response())
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify(row))
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
    const modelRequest = events.find(event => event.type === 'model.request')!
    const modelResponse = events.find(event => event.type === 'model.response')!
    assert.equal(modelRequest.attrs?.content_omitted, true)
    assert.equal(events.find(event => event.type === 'run.end')?.attrs?.omitted_bodies, 1)
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
    const manifest = JSON.parse(await readFile(join(await recordedRunDirectory(f.root, row.agenticreplay_run_id), 'manifest.json'), 'utf8'))
    assert.equal(typeof manifest.agenticreplay_version, 'string')
    assert.equal(manifest.orca_version, undefined)
    await access(join(await recordedRunDirectory(f.root, row.agenticreplay_run_id), 'manifest.json'))
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
    const manifest = JSON.parse(await readFile(join(await recordedRunDirectory(f.root, row.agenticreplay_run_id), 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.env_allowlisted, {})
    assert.equal(manifest.agenticreplay_version, '0.2.99')
    assert.equal(manifest.exit_code, undefined)
    const nativeReader = await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))
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
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
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
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
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
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
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
    const diagnostic = JSON.parse(await readFile(join(await recordedRunDirectory(f.root, rows[0]!.agenticreplay_run_id), 'capture-status.json'), 'utf8'))
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

test('malformed string arguments are redacted in a bounded envelope and capture continues', async () => {
  const f = await agenticReplayFixture()
  try {
    const malformed = '{"action":"propose","token":"sk-testsecret123456789"}}'
    const rejected = { token: Symbol(), callId: 'bad-call', rootCallId: 'bad-call', name: 'coding_workflow_apply', arguments: malformed }
    const valid = { token: Symbol(), callId: 'valid-call', rootCallId: 'valid-call', name: 'coding_workflow_apply', arguments: { action: 'propose' } }
    f.recorder.preTool(f.binding, rejected)
    f.recorder.toolResult(f.binding, rejected, { isError: true, content: [{ type: 'text', text: 'Invalid arguments' }] })
    f.recorder.preTool(f.binding, valid)
    f.recorder.toolResult(f.binding, valid, { isError: false, content: [{ type: 'text', text: 'accepted' }] })
    await f.recorder.shutdown()

    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed')
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
    const calls = events.filter(event => event.type === 'tool.call')
    const results = events.filter(event => event.type === 'tool.result')
    assert.equal(calls.length, 2)
    assert.equal(results.length, 2)
    assert.deepEqual(calls[0]?.payload, { format: 'dsh.tool.arguments.v1', encoding: 'invalid-json', text: '{"action":"propose","token":"[REDACTED]"}}' })
    assert.deepEqual(calls[1]?.payload, { action: 'propose' })
    assert.equal(JSON.stringify(events).includes('sk-testsecret123456789'), false)
  } finally { await f.dispose() }
})

test('writer failure persists safe phase, event type, call id and code without arguments or exception text', async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (...args) => {
    const writer = await TraceWriter.create(...args)
    const append = writer.append.bind(writer)
    writer.append = async event => {
      if (event.type === 'tool.call') throw Object.assign(new Error('PRIVATE-APPEND-DETAIL'), { code: 'EIO' })
      return append(event)
    }
    return writer
  } })
  try {
    const secretArguments = '{"api_key":"PRIVATE-ARGUMENT"}}'
    const exec = { token: Symbol(), callId: 'safe-call-id', rootCallId: 'safe-call-id', name: 'tool', arguments: secretArguments }
    f.recorder.preTool(f.binding, exec)
    f.recorder.toolResult(f.binding, exec, { isError: true, content: [{ type: 'text', text: 'rejected' }] })
    await f.recorder.shutdown()

    const row = (await f.reader.list(f.binding))[0]!
    const diagnostic = JSON.parse(await readFile(join(await recordedRunDirectory(f.root, row.agenticreplay_run_id), 'capture-status.json'), 'utf8'))
    assert.equal(diagnostic.lastErrorCode, 'recording_io_failed')
    assert.deepEqual(diagnostic.failure, { phase: 'tool_call_append', eventType: 'tool.call', callId: 'safe-call-id', code: 'recording_io_failed' })
    const serialized = JSON.stringify(diagnostic)
    assert.equal(serialized.includes('PRIVATE-APPEND-DETAIL'), false)
    assert.equal(serialized.includes('PRIVATE-ARGUMENT'), false)
  } finally { await f.dispose() }
})

test('recording enabled or disabled leaves the same next model result', async () => {
  const outputs = []
  for (const enabled of [true, false]) {
    const f = await agenticReplayFixture({ enabled })
    try {
      const expected = response()
      const actual = await collect(f.recorder.stream(f.binding, request, () => chunks(expected)))
      const malformed = { token: Symbol(), callId: 'invalid', rootCallId: 'invalid', name: 'coding_workflow_apply', arguments: '{"action":"propose"}}' }
      const rejected = { isError: true, content: [{ type: 'text', text: 'Invalid arguments' }] }
      f.recorder.preTool(f.binding, malformed)
      f.recorder.toolResult(f.binding, malformed, rejected)
      outputs.push({ actual, rejected })
      await f.recorder.shutdown()
    } finally { await f.dispose() }
  }
  assert.deepEqual(outputs[0], outputs[1])
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
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
    const results = events.filter(event => event.type === 'tool.result')
    assert.deepEqual(results.map(event => event.attrs?.is_error), [true, true, true, true, false])
    assert.ok(results.every(event => event.attrs?.native_is_error === false))
    assert.ok(results.slice(0, 4).every(event => event.attrs?.error_flag_conflict === true))
    assert.equal(results[4]?.attrs?.error_flag_conflict, undefined)
    assert.equal(JSON.stringify(events).includes('PRIVATE-ERROR-BODY'), false)
  } finally { await f.dispose() }
})

test('multiline directory output with high-entropy names remains valid redacted JSON and does not stop recording', async () => {
  const f = await agenticReplayFixture()
  try {
    const exec = { token: Symbol('directory-list'), callId: 'directory-list', rootCallId: 'directory-list', name: 'bash', arguments: { command: 'fixture directory listing' } }
    f.recorder.start(f.binding)
    f.recorder.preTool(f.binding, exec)
    f.recorder.toolDecision(exec, { kind: 'allow' })
    f.recorder.toolDispatch(exec)
    f.recorder.toolDispatched(exec)
    f.recorder.toolResult(f.binding, exec, { isError: false, content: [{ type: 'text',
      text: '\nCaptureFolder-D3pMyMs\nAPI_KEY=sk-unitsecret1234567890\nHarmless directory-list suffix' }] })
    await collect(f.recorder.stream(f.binding, request, () => chunks(response('continued after directory listing'))))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify({ state: row.state, error: row.last_error_code }))
    assert.equal(row.missing_event_count, 0)
    const runDir = await recordedRunDirectory(f.root, row.agenticreplay_run_id)
    const events = await (await TraceReader.open(runDir)).events()
    const tool = events.find(event => event.type === 'tool.result')!
    let payload: any = tool.payload
    if (typeof payload?.$blob === 'string') {
      const digest = payload.$blob.replace('sha256:', '')
      payload = JSON.parse(await readFile(join(runDir, 'blobs', digest.slice(0, 2), digest), 'utf8'))
    }
    assert.ok(payload.content[0].text.includes('Harmless directory-list suffix'))
    assert.equal(JSON.stringify(payload).includes('sk-unitsecret1234567890'), false)
    assert.ok(events.some(event => event.type === 'model.response'))
  } finally { await f.dispose() }
})


test('SDK changes its run directory on close without breaking recorder finalization', async () => {
  let originalDirectory = '', relocatedDirectory = ''
  const f = await agenticReplayFixture({ shutdownDrainTimeoutMs: 1000 }, { createWriter: async (...args) => {
    const writer = await TraceWriter.create(...args)
    let directory = writer.runDir
    originalDirectory = directory
    return {
      get runDir() { return directory },
      append: writer.append.bind(writer),
      close: async () => {
        const manifest = await writer.close()
        relocatedDirectory = writer.runDir + '-sdk-session-title'
        await rename(writer.runDir, relocatedDirectory)
        directory = relocatedDirectory
        return manifest
      },
    }
  } })
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed', JSON.stringify({ state: row.state, error: row.last_error_code }))
    assert.notEqual(originalDirectory, relocatedDirectory)
    assert.equal(f.recorder.status(f.binding.sessionId).trace?.run_directory, relocatedDirectory)
    await access(join(relocatedDirectory, 'events.jsonl'))
    assert.equal(f.recorder.status(f.binding.sessionId).persistenceFailed, false)
  } finally { await f.dispose() }
})

test('run.start records observed runtime evidence rather than a fixed verified release', async () => {
  const f = await agenticReplayFixture();
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())));
    await f.recorder.shutdown();
    const row = (await f.reader.list(f.binding))[0]!;
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events();
    const payload = events.find(event => event.type === 'run.start')!.payload as any;
    assert.equal(Object.hasOwn(payload, 'verifiedDshVersion'), false);
    assert.equal(payload.runtime.nodeVersion, process.version);
    assert.equal(payload.runtime.dshVersion, null, 'the test runner does not expose a DSH launcher version');
  } finally { await f.dispose() }
});

test('three native turns preserve request/result ownership without ending the session run', async () => {
  const f = await agenticReplayFixture()
  try {
    for (const turn of [1, 2, 3]) {
      const binding = { ...f.binding, turn }
      // Two LLM calls in one native turn must not become two invented turns.
      for (let call = 0; call < 2; call++) await collect(f.recorder.stream(binding, request, () => chunks(response())))
      const exec = { token: Symbol(), callId: `call-${turn}`, rootCallId: `call-${turn}`, name: 'fixture', arguments: {}, turn }
      f.recorder.preTool(binding, exec)
      f.recorder.toolResult(binding, exec, { isError: false, content: [] })
      await f.recorder.flushDiagnostics(binding.sessionId)
      const dir = f.recorder.status(binding.sessionId).trace!.run_directory!
      const open = await (await TraceReader.open(dir)).events()
      assert.equal(open.filter(event => event.type === 'run.end').length, 0)
      assert.equal(f.recorder.status(binding.sessionId).trace!.state, 'recording')
    }
    await f.recorder.closeSessionRecording(f.binding.sessionId, 'session_disposed')
    const row = (await f.reader.list(f.binding))[0]!
    const dir = await recordedRunDirectory(f.root, row.agenticreplay_run_id)
    const events = await (await TraceReader.open(dir)).events()
    assert.deepEqual(events.filter(event => event.type === 'model.request').map(event => event.turn), [1, 1, 2, 2, 3, 3])
    for (const event of events.filter(event => ['model.response', 'tool.result'].includes(event.type))) {
      assert.equal(event.turn, events.find(cause => cause.seq === event.causes?.[0])!.turn)
      assert.ok(event.turn >= 1 && event.turn <= 3)
    }
    assert.equal(events.filter(event => event.type === 'run.end').length, 1)
    assert.equal(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).capture.status, 'unverified')
  } finally { await f.dispose() }
})


test('sub-budget multi-message requests retain redacted content in digest-verified blobs', async () => {
  const f = await agenticReplayFixture({ maxQueuedBytesPerTrace: 524_288 })
  try {
    const texts = ['a'.repeat(40_000), 'b'.repeat(40_000), 'c'.repeat(40_000) + ' password=FAKEONLY_DUMMY_CREDENTIAL status=ok']
    const input = { ...request, messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })) }
    await collect(f.recorder.stream(f.binding, input, () => chunks(response())))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed')
    const dir = await recordedRunDirectory(f.root, row.agenticreplay_run_id)
    const events = await (await TraceReader.open(dir)).events()
    const event = events.find(event => event.type === 'model.request')!
    assert.notEqual(event.attrs?.content_omitted, true)
    const ref = event.payload as { $blob: string; bytes: number }
    assert.ok(ref.$blob, 'existing SDK content-addressed spill preserves the full request')
    const digest = ref.$blob.replace('sha256:', '')
    const bytes = await readFile(join(dir, 'blobs', digest.slice(0, 2), digest))
    assert.equal(bytes.length, ref.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest)
    const restored = JSON.parse(bytes.toString('utf8'))
    assert.deepEqual(restored.messages.map((message: any) => message.content[0].text),
      [texts[0], texts[1], 'c'.repeat(40_000) + ' password=[REDACTED] status=ok'])
    assert.equal(bytes.includes('FAKEONLY_DUMMY_CREDENTIAL'), false)
    assert.equal(f.recorder.diagnostics.omittedBodies, 0)
    assert.equal(input.messages[2]!.content[0]!.text, texts[2], 'caller data is not mutated')
  } finally { await f.dispose() }
})


test('late tool results keep their original turn and absent attribution stays explicit', async () => {
  const f = await agenticReplayFixture()
  try {
    const first = { ...f.binding, turn: 1 }, second = { ...f.binding, turn: 2 }
    const exec = { token: Symbol(), callId: 'late', rootCallId: 'late', name: 'fixture', arguments: {}, turn: 1 }
    f.recorder.preTool(first, exec)
    await collect(f.recorder.stream(second, request, () => chunks(response())))
    f.recorder.toolDecision(exec, { kind: 'allow' })
    f.recorder.toolResult(second, exec, { isError: false, content: [] })
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
    assert.equal(events.find(event => event.type === 'tool.result')?.turn, 1)
    assert.equal(events.find(event => event.attrs?.decision === 'allow')?.turn, 1)
    const requests = events.filter(event => event.type === 'model.request')
    assert.deepEqual(requests.map(event => [event.turn, event.attrs?.native_turn_known]), [[2, true], [0, false]])
  } finally { await f.dispose() }
})
